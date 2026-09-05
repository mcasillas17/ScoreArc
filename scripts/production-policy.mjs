export const repository = 'mcasillas17/ScoreArc';
export const services = ['reader', 'ingester', 'frontend'];

/** @param {string} value */
export function assertSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error('Expected a full lowercase commit SHA');
}

/**
 * @param {{repository: string, eventName: string, ref: string, sha: string,
 * workflowRef: string, runId: number, runAttempt: number}} context
 * @param {{id: number, run_attempt: number, event: string, head_branch: string,
 * head_sha: string, path: string, status: string, conclusion: string | null,
 * repository: {full_name: string}, head_repository: {full_name: string}}} run
 * @param {{name: string, run_id: number, run_attempt: number, head_sha: string,
 * status: string, conclusion: string | null}[]} jobs
 */
export function assertReleaseContext(context, run, jobs) {
  assertSha(context.sha);
  if (context.repository !== repository || context.ref !== 'refs/heads/main' ||
      !['push', 'workflow_dispatch'].includes(context.eventName) ||
      context.workflowRef !== `${repository}/.github/workflows/ci.yml@refs/heads/main` ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      run.id !== context.runId || run.run_attempt !== context.runAttempt ||
      run.event !== context.eventName || run.head_branch !== 'main' ||
      run.head_sha !== context.sha || run.path !== '.github/workflows/ci.yml' ||
      run.status !== 'in_progress' || run.conclusion !== null) {
    throw new Error('Release requires this repository\'s active main CI run and exact tested SHA');
  }
  const tests = jobs.filter(job => job.name === 'test');
  if (tests.length !== 1 || tests[0].run_id !== context.runId ||
      tests[0].run_attempt !== context.runAttempt || tests[0].head_sha !== context.sha ||
      tests[0].status !== 'completed' || tests[0].conclusion !== 'success') {
    throw new Error('Required test job is not successful in this attempt; dispatch CI or re-run all jobs');
  }
}

/** @param {string} path @param {string} service */
export function affectsService(path, service) {
  if (/\.md$/i.test(path) || path.startsWith('docs/') || path.startsWith('infra/')) return false;
  if (path === '.github/workflows/ci.yml' || path === '.github/workflows/deploy-production.yml' ||
      path.startsWith('scripts/production-')) return true;
  if (service === 'frontend') return !path.startsWith('backend/') && !path.startsWith('.github/');
  return path.startsWith(`backend/${service}/`) || path.startsWith('backend/shared/') ||
    path.startsWith('backend/config/') || path.startsWith('backend/migrations/') ||
    ['backend/go.mod', 'backend/go.sum', 'backend/.dockerignore'].includes(path);
}

/**
 * @param {{service: string, sha: string, mainSha: string, baseSha: string | null,
 * paths: string[], manual: string}} input
 */
export function planRelease({ service, sha, mainSha, baseSha, paths, manual }) {
  assertSha(sha);
  assertSha(mainSha);
  if (baseSha !== null) assertSha(baseSha);
  if (!services.includes(service) || !['changed', 'all', ...services].includes(manual)) {
    throw new Error('Unknown release service or manual selection; rollback requires a revert PR');
  }
  if (sha !== mainSha) return { deploy: false, reason: 'stale-main', sha };
  if (manual !== 'changed') {
    const deploy = manual === 'all' || manual === service;
    return { deploy, reason: deploy ? 'manual-redeploy' : 'not-selected', sha };
  }
  if (baseSha === null) return { deploy: true, reason: 'bootstrap-or-recovery', sha };
  const deploy = paths.some(path => affectsService(path, service));
  return { deploy, reason: deploy ? 'changed-paths' : 'unchanged-paths', sha };
}

/**
 * @param {{fly?: string, stage?: string, promote?: string,
 * precheckCurrent?: string, promoteCurrent?: string}} outcomes
 */
export function releaseStatus(outcomes) {
  if (outcomes.fly === 'success' || outcomes.promote === 'success') return 'success';
  if (outcomes.precheckCurrent === 'false' || outcomes.promoteCurrent === 'false' ||
      outcomes.stage === 'failure') return 'inactive';
  return 'failure';
}

/**
 * @param {{id: string, accountId: string, autoAssignCustomDomains: boolean,
 * link?: {type: string, org: string, repo: string, productionBranch: string, deployHooks: unknown[]} | null}} project
 * @param {string} projectId @param {string} teamId
 */
export function assertVercelProject(project, projectId, teamId) {
  if (!projectId || !teamId || project.id !== projectId || project.accountId !== teamId ||
      project.autoAssignCustomDomains !== false) {
    throw new Error('Vercel project must match configured IDs and have automatic domain assignment OFF');
  }
  if (project.link && (project.link.type !== 'github' || project.link.org !== 'mcasillas17' ||
      project.link.repo !== 'ScoreArc' || project.link.productionBranch !== 'main' ||
      !Array.isArray(project.link.deployHooks) || project.link.deployHooks.length !== 0)) {
    throw new Error('Unexpected Vercel Git link or deploy hooks; audit production entry points');
  }
}
