import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertReleaseContext, assertSha, assertVercelProject, planRelease, releaseStatus, repository, services } from './production-policy.mjs';

/** @param {string} token @param {typeof fetch} fetcher */
export function githubClient(token, fetcher = fetch) {
  if (!token) throw new Error('GH_TOKEN is required');
  /** @param {string} path @param {Record<string, unknown>} [body] */
  const request = async (path, body) => {
    const response = await fetcher(`https://api.github.com/repos/${repository}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
    return response.json();
  };
  return request;
}

/** @param {ReturnType<typeof githubClient>} api @param {string} path @param {string | null} key */
export async function paginate(api, path, key = null) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const data = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const entries = key === null ? data : data[key];
    if (!Array.isArray(entries)) throw new Error(`Invalid paginated response for ${path}`);
    result.push(...entries);
    if (entries.length < 100) return result;
  }
  throw new Error(`Pagination limit reached for ${path}; refusing a partial release history`);
}

/** @param {ReturnType<typeof githubClient>} api @param {string} service */
export async function deployedBase(api, service) {
  // GitHub lists deployments newest-first, as it does deployment statuses.
  const releases = await api(`deployments?environment=production-${service}&task=scorearc-release&per_page=1`);
  if (!Array.isArray(releases)) throw new Error('Invalid deployment ledger response');
  const latest = releases[0];
  if (!latest) return null;
  if (latest.performed_via_github_app?.id !== 15368 || latest.payload?.version !== 1 ||
      latest.payload?.service !== service || latest.task !== 'scorearc-release' ||
      latest.environment !== `production-${service}`) {
    throw new Error('Unrecognized production ledger entry; reconcile it before releasing');
  }
  assertSha(latest.sha);
  const statuses = await api(`deployments/${latest.id}/statuses?per_page=1`);
  if (!Array.isArray(statuses)) throw new Error('Invalid deployment status response');
  if (statuses[0]?.state === 'success') return latest.sha;
  // "inactive" proves publication never started or acknowledges operator
  // reconciliation. A publication timeout may still be running remotely.
  if (statuses[0]?.state === 'inactive') return null;
  throw new Error(`Release ${latest.id} is unresolved; reconcile provider-side operations before retrying`);
}

/** @param {string} service @param {string} sha @param {number} runId @param {number} runAttempt */
export function deploymentRequest(service, sha, runId, runAttempt) {
  return {
    ref: sha, task: 'scorearc-release', environment: `production-${service}`,
    // The mandatory Actions test job is verified by validateRun; this REST
    // field checks legacy commit statuses, not that job's check run.
    auto_merge: false, required_contexts: [], production_environment: true,
    payload: { version: 1, service, runId, runAttempt },
    description: `CI-gated ${service} release`,
  };
}

/** @param {string} base @param {string} sha */
export function changedPaths(base, sha) {
  assertSha(base);
  assertSha(sha);
  execFileSync('git', ['merge-base', '--is-ancestor', base, sha], { stdio: 'pipe' });
  return execFileSync('git', ['diff', '--name-only', '--no-renames', '-z', base, sha, '--'], {
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
}

/** @param {Record<string, string | undefined>} env */
function contextFromEnv(env) {
  return {
    repository: env.GITHUB_REPOSITORY, eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF,
    sha: env.GITHUB_SHA, workflowRef: env.GITHUB_WORKFLOW_REF,
    runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
  };
}

/** @param {ReturnType<typeof githubClient>} api @param {Record<string, string | undefined>} env */
export async function validateRun(api, env) {
  const context = contextFromEnv(env);
  const run = await api(`actions/runs/${context.runId}`);
  const jobs = await paginate(api, `actions/runs/${context.runId}/attempts/${context.runAttempt}/jobs`, 'jobs');
  assertReleaseContext(context, run, jobs);
  const branch = await api('git/ref/heads/main');
  assertSha(branch.object.sha);
  return { sha: context.sha, mainSha: branch.object.sha };
}

/** @param {Record<string, string | undefined>} env @param {typeof fetch} fetcher */
export async function validateVercel(env, fetcher = fetch) {
  const { VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_ORG_ID } = env;
  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID || !VERCEL_ORG_ID) {
    throw new Error('VERCEL_TOKEN, VERCEL_PROJECT_ID and VERCEL_ORG_ID are required; no deployment occurred');
  }
  const response = await fetcher(
    `https://api.vercel.com/v9/projects/${encodeURIComponent(VERCEL_PROJECT_ID)}?teamId=${encodeURIComponent(VERCEL_ORG_ID)}`,
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` }, signal: AbortSignal.timeout(30_000) },
  );
  if (!response.ok) throw new Error(`Read Vercel production settings: HTTP ${response.status}`);
  assertVercelProject(await response.json(), VERCEL_PROJECT_ID, VERCEL_ORG_ID);
}

/**
 * @param {Record<string, string | undefined>} env @param {string} deploymentUrl
 * @param {typeof fetch} fetcher @param {() => Promise<void>} pause
 */
export async function confirmVercelPublication(env, deploymentUrl, fetcher = fetch, pause = () => delay(5000)) {
  const url = new URL(deploymentUrl.trim());
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.vercel.app') ||
      url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Unexpected staged Vercel deployment URL');
  }
  const read = async path => {
    const response = await fetcher(`https://api.vercel.com/${path}?teamId=${encodeURIComponent(env.VERCEL_ORG_ID)}`, {
      headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` }, signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Verify Vercel publication: HTTP ${response.status}`);
    return response.json();
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const deployment = await read(`v13/deployments/${encodeURIComponent(url.hostname)}`);
    if (!deployment.id || deployment.projectId !== env.VERCEL_PROJECT_ID ||
        deployment.meta?.scorearcCommitSha !== env.GITHUB_SHA || deployment.readyState !== 'READY' ||
        deployment.target !== 'production' || deployment.aliasError) {
      throw new Error('Exact tested Vercel deployment has not completed production promotion');
    }
    if (deployment.aliasAssigned === true) {
      const alias = await read('v4/aliases/www.scorearc.futbol');
      if (alias.projectId === env.VERCEL_PROJECT_ID && alias.deploymentId === deployment.id) return;
    }
    if (attempt < 2) await pause();
  }
  throw new Error('Production domain does not serve this tested Vercel deployment after bounded confirmation');
}

/** @param {Record<string, string | number | boolean>} values */
function outputs(values) {
  for (const [key, value] of Object.entries(values)) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}

async function main() {
  const env = process.env;
  const service = env.RELEASE_SERVICE;
  if (!services.includes(service)) throw new Error('RELEASE_SERVICE must be reader, ingester or frontend');
  const command = process.argv[2];
  const logUrl = `https://github.com/${repository}/actions/runs/${env.GITHUB_RUN_ID}`;

  if (command === 'confirm-vercel') {
    await confirmVercelPublication(env, readFileSync(join(env.RUNNER_TEMP, 'production-url.txt'), 'utf8'));
    return;
  }
  const api = githubClient(env.GH_TOKEN);
  if (command === 'finish') {
    if (!/^\d+$/.test(env.RELEASE_ID ?? '')) throw new Error('A deployment ledger ID is required');
    const state = releaseStatus({
      fly: env.FLY_OUTCOME, stage: env.STAGE_OUTCOME, promote: env.PROMOTE_OUTCOME,
      precheckCurrent: env.PRECHECK_CURRENT, promoteCurrent: env.PROMOTE_CURRENT,
    });
    await api(`deployments/${env.RELEASE_ID}/statuses`, {
      state,
      description: state === 'success' ? 'Production publication confirmed'
        : state === 'inactive' ? 'No publication started; superseded or inert build failed'
          : 'Release unresolved; operator must reconcile before retry',
      log_url: logUrl, auto_inactive: false,
    });
    return;
  }

  const { sha, mainSha } = await validateRun(api, env);
  if (command === 'prepare') {
    const baseSha = await deployedBase(api, service);
    const paths = baseSha === null || sha !== mainSha ? [] : changedPaths(baseSha, sha);
    const plan = planRelease({
      service, sha, mainSha, baseSha, paths,
      manual: env.GITHUB_EVENT_NAME === 'workflow_dispatch' ? env.RELEASE_SELECTION : 'changed',
    });
    outputs({ ...plan, base: baseSha ?? 'none' });
    appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${service}\n\n${plan.reason}: \`${sha}\`; baseline \`${baseSha ?? 'none (bootstrap/recovery)'}\`.\n`);
    return;
  }
  if (command === 'assert' && sha !== mainSha) {
    outputs({ current: false });
    appendFileSync(env.GITHUB_STEP_SUMMARY, `\n${service}: superseded before publication; no production change.\n`);
    return;
  }
  if (sha !== mainSha) throw new Error('Main advanced before publication; retry CI on current main');
  if (service === 'frontend') await validateVercel(env);
  if (command === 'assert') {
    outputs({ current: true });
    return;
  }
  if (command !== 'begin') throw new Error('Expected prepare, begin, assert or finish');
  const deployment = await api('deployments',
    deploymentRequest(service, sha, Number(env.GITHUB_RUN_ID), Number(env.GITHUB_RUN_ATTEMPT)));
  if (!Number.isSafeInteger(deployment.id) || deployment.sha !== sha) throw new Error('Invalid deployment ledger response');
  outputs({ id: deployment.id });
  await api(`deployments/${deployment.id}/statuses`, {
    state: 'in_progress', log_url: logUrl, auto_inactive: false,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
