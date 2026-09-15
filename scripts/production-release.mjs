import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { assertReleaseContext, assertSha, assertVercelProject, assessIngesterMachines, ingesterApp, planRelease, releaseStatus, repository, services } from './production-policy.mjs';

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

/** @param {{id?: number, login?: string, type?: string} | null | undefined} creator */
function isActionsBot(creator) {
  return creator?.id === 41898282 && creator.login === 'github-actions[bot]' && creator.type === 'Bot';
}

/** @param {ReturnType<typeof githubClient>} api @param {string} service */
export async function deployedBase(api, service) {
  // GitHub lists deployments newest-first, as it does deployment statuses.
  const releases = await api(`deployments?environment=production-${service}&task=scorearc-release&per_page=1`);
  if (!Array.isArray(releases)) throw new Error('Invalid deployment ledger response');
  const latest = releases[0];
  if (!latest) return null;
  // Actual Actions deployments can omit app metadata; creator is server-owned.
  if (!isActionsBot(latest.creator) ||
      (latest.performed_via_github_app != null && latest.performed_via_github_app.id !== 15368) ||
      latest.payload?.version !== 1 ||
      latest.payload?.service !== service || latest.task !== 'scorearc-release' ||
      latest.environment !== `production-${service}`) {
    throw new Error('Unrecognized production ledger entry; reconcile it before releasing');
  }
  assertSha(latest.sha);
  const statuses = await api(`deployments/${latest.id}/statuses?per_page=1`);
  if (!Array.isArray(statuses)) throw new Error('Invalid deployment status response');
  if (statuses[0]?.state === 'success') {
    if (!isActionsBot(statuses[0].creator)) throw new Error('Unrecognized production success author; reconcile before releasing');
    return latest.sha;
  }
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

/** @param {Record<string, string | undefined>} env @param {typeof fetch} fetcher @param {AbortSignal} [signal] */
function vercelClient(env, fetcher, signal) {
  const { VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_ORG_ID } = env;
  if (!VERCEL_TOKEN || !VERCEL_PROJECT_ID || !VERCEL_ORG_ID) {
    throw new Error('VERCEL_TOKEN, VERCEL_PROJECT_ID and VERCEL_ORG_ID are required; no deployment occurred');
  }
  // Native header-validation errors can include the rejected credential value.
  if (!/^[\x21-\x7e]+$/.test(VERCEL_TOKEN)) {
    throw new Error('Invalid Vercel token format; no deployment occurred');
  }
  if (!/^prj_[a-zA-Z0-9]{1,128}$/.test(VERCEL_PROJECT_ID) ||
      !/^team_[a-zA-Z0-9]{1,128}$/.test(VERCEL_ORG_ID)) {
    throw new Error('Invalid Vercel project or team identifier');
  }
  return async (path, method = 'GET') => {
    const requestTimeout = AbortSignal.timeout(30_000);
    const url = new URL(`https://api.vercel.com/${path}`);
    url.searchParams.set('teamId', VERCEL_ORG_ID);
    const response = await fetcher(url.href, {
      method, redirect: 'error',
      headers: { Authorization: `Bearer ${VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
      signal: signal ? AbortSignal.any([signal, requestTimeout]) : requestTimeout,
    });
    if (!(method === 'POST' ? [201, 202] : [200]).includes(response.status)) {
      throw new Error(`Vercel ${method === 'POST' ? 'promotion' : 'metadata read'}: HTTP ${response.status}; release remains unresolved`);
    }
    // Promotion's 201/202 contract has no JSON response body.
    if (method === 'POST') return response.status;
    try {
      return await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new Error('Vercel metadata is not valid JSON; release remains unresolved');
    }
  };
}

/** @param {Record<string, string | undefined>} env @param {typeof fetch} fetcher */
export async function validateVercel(env, fetcher = fetch) {
  const project = await vercelClient(env, fetcher)(`v9/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID)}`);
  assertVercelProject(project, env.VERCEL_PROJECT_ID, env.VERCEL_ORG_ID);
}

/** @param {string} deploymentUrl */
function stagedHostname(deploymentUrl) {
  if (!/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.vercel\.app\/?$/.test(deploymentUrl.trim())) {
    throw new Error('Unexpected staged Vercel deployment URL');
  }
  return new URL(deploymentUrl.trim()).hostname;
}

function assertVercelRun(env) {
  assertSha(env.GITHUB_SHA);
  if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_ID ?? '') || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT ?? '')) {
    throw new Error('Vercel publication requires the exact CI run and attempt');
  }
}

function assertTestedDeployment(env, deployment, expectedId) {
  if (!/^dpl_[a-zA-Z0-9]{1,128}$/.test(deployment?.id ?? '') ||
      (expectedId && deployment.id !== expectedId) || deployment.projectId !== env.VERCEL_PROJECT_ID ||
      deployment.meta?.scorearcCommitSha !== env.GITHUB_SHA ||
      deployment.meta?.scorearcRunId !== env.GITHUB_RUN_ID ||
      deployment.meta?.scorearcRunAttempt !== env.GITHUB_RUN_ATTEMPT ||
      deployment.readyState !== 'READY' || deployment.target !== 'production' || deployment.aliasError) {
    throw new Error('Exact tested Vercel deployment is not ready for production promotion');
  }
}

async function confirmDeployment(env, identifier, read, pause) {
  let deploymentId = identifier.startsWith('dpl_') ? identifier : undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const deployment = await read(`v13/deployments/${encodeURIComponent(deploymentId ?? identifier)}`);
    assertTestedDeployment(env, deployment, deploymentId);
    deploymentId = deployment.id;
    if (deployment.aliasAssigned === true) {
      const alias = await read('v4/aliases/www.scorearc.futbol');
      if (alias?.projectId === env.VERCEL_PROJECT_ID && alias.deploymentId === deploymentId) return;
    }
    if (attempt < 2) await pause();
  }
  throw new Error('Production domain does not serve this tested Vercel deployment after bounded confirmation');
}

/**
 * @param {Record<string, string | undefined>} env @param {string} deploymentUrl
 * @param {typeof fetch} fetcher @param {() => Promise<void>} pause
 */
export async function confirmVercelPublication(env, deploymentUrl, fetcher = fetch, pause = () => delay(5000)) {
  const hostname = stagedHostname(deploymentUrl);
  assertVercelRun(env);
  const read = vercelClient(env, fetcher);
  await confirmDeployment(env, hostname, read, pause);
}

/**
 * @param {Record<string, string | undefined>} env @param {string} deploymentUrl
 * @param {typeof fetch} fetcher @param {() => Promise<void>} [pause]
 */
export async function promoteVercelPublication(env, deploymentUrl, fetcher = fetch, pause) {
  const hostname = stagedHostname(deploymentUrl);
  assertVercelRun(env);
  const deadline = AbortSignal.timeout(600_000);
  const read = vercelClient(env, fetcher, deadline);
  const wait = pause ?? (() => delay(5000, undefined, { signal: deadline }));
  // Vercel returns lastAliasRequest: null unless promotion metadata is requested.
  const projectPath = `v9/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID)}?rollbackInfo=true`;
  const project = await read(projectPath);
  assertVercelProject(project, env.VERCEL_PROJECT_ID, env.VERCEL_ORG_ID);
  if (['pending', 'in-progress'].includes(project.lastAliasRequest?.jobStatus)) {
    throw new Error('Vercel has a pending publication; reconcile the unresolved operation before promotion');
  }
  const deployment = await read(`v13/deployments/${encodeURIComponent(hostname)}`);
  assertTestedDeployment(env, deployment);
  // Send once only. A lost response or local timeout does not cancel remote work.
  await read(`v10/projects/${encodeURIComponent(env.VERCEL_PROJECT_ID)}/promote/${encodeURIComponent(deployment.id)}`, 'POST');
  for (let attempt = 0; attempt < 120; attempt++) {
    deadline.throwIfAborted();
    const current = await read(projectPath);
    assertVercelProject(current, env.VERCEL_PROJECT_ID, env.VERCEL_ORG_ID);
    const job = current.lastAliasRequest;
    // A 202 can leave the previous job visible while this promotion is queued.
    if (job?.type === 'promote' && job.toDeploymentId === deployment.id &&
        Number.isFinite(job.requestedAt) && job.requestedAt > (project.lastAliasRequest?.requestedAt ?? 0)) {
      if (job.jobStatus === 'succeeded') {
        await confirmDeployment(env, deployment.id, read, wait);
        return;
      }
      if (!['pending', 'in-progress'].includes(job.jobStatus)) {
        throw new Error('Vercel promotion failed, was skipped, or has an unknown status; release remains unresolved');
      }
    }
    if (attempt < 119) await wait();
  }
  throw new Error('Vercel promotion timed out; reconcile provider state before retrying the unresolved release');
}

export const ingesterVerification = { pollMs: 5_000, stableObservations: 3, deadlineMs: 120_000, callTimeoutMs: 30_000 };

/**
 * Read-only machine inventory through the pinned flyctl and the step's FLY_API_TOKEN.
 * @param {number} timeout @param {string} [command]
 * @returns {Promise<string>}
 */
export function flyMachineList(timeout, command = 'flyctl') {
  return new Promise((resolve, reject) => {
    execFile(command, ['machines', 'list', '--app', ingesterApp, '--json'],
      { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (!error) return resolve(stdout);
        // Constant text only: provider output can carry machine configuration.
        const reason = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'exceeded its output limit'
          : error.killed ? `timed out after ${timeout} ms`
            : `failed (exit ${Number.isInteger(error.code) ? error.code : 'unavailable'})`;
        reject(new Error(`flyctl machine list ${reason}`));
      });
  });
}

/**
 * Confirms the deployed singleton contract without changing anything. Only a
 * non-started state or an inventory read error is retried inside the deadline.
 * Machine readiness is not evidence of data freshness or complete ingestion.
 * @param {(timeout: number) => Promise<string>} list
 * @param {(ms: number) => Promise<unknown>} pause @param {() => number} now
 */
export async function verifyIngesterMachines(list = flyMachineList, pause = ms => delay(ms), now = Date.now) {
  const { pollMs, stableObservations, deadlineMs, callTimeoutMs } = ingesterVerification;
  const deadline = now() + deadlineMs;
  let stableId = null;
  let streak = 0;
  for (;;) {
    let observation;
    try {
      const text = await list(callTimeoutMs);
      let inventory;
      try { inventory = JSON.parse(text); } catch { inventory = text; }
      observation = assessIngesterMachines(inventory);
    } catch (error) {
      observation = { failures: [`machineList (${error instanceof Error ? error.message : 'unknown error'})`], machines: [] };
    }
    const { failures, machines } = observation;
    const id = failures.length === 0 ? machines[0].id : null;
    streak = id !== null && id === stableId ? streak + 1 : Number(id !== null);
    stableId = id;
    if (streak >= stableObservations) return machines[0];
    const retryable = failures.every(failure => failure === 'started' || failure.startsWith('machineList'));
    // Start no call that could outlast the deadline: a clipped final call would
    // report its own timeout instead of the machine state already observed.
    if (!retryable || now() + pollMs + callTimeoutMs > deadline) {
      const unmet = failures.length > 0 ? failures : [`stableObservations (${streak} of ${stableObservations})`];
      const observed = machines.map(machine => `${machine.id}=${machine.state}`).join(', ') || 'none';
      throw new Error(`Ingester machine contract not met${retryable ? ` within ${deadlineMs / 1000}s` : ''}; ` +
        `failed conditions: ${unmet.join(', ')}; observed machines: ${observed}. ` +
        'No repair, start, scale or redeploy was attempted. This release stays unresolved: reconcile the ' +
        'machine (docs/backend/SETUP.md §7.4), then acknowledge the ledger (docs/backend/RELEASES.md, ' +
        'Interrupted-release recovery) before retrying.');
    }
    await pause(pollMs);
  }
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
  if (command === 'promote-vercel') {
    if (service !== 'frontend') throw new Error('Vercel promotion is frontend-only');
    await promoteVercelPublication(env, readFileSync(join(env.RUNNER_TEMP, 'production-url.txt'), 'utf8'));
    return;
  }
  if (command === 'verify-ingester') {
    if (service !== 'ingester') throw new Error('Machine verification is ingester-only');
    const { id } = await verifyIngesterMachines();
    console.log(`Ingester machine contract verified: ${id} started, no standby targets, restart policy always, ` +
      `${ingesterVerification.stableObservations} consecutive observations. This does not prove data freshness or complete ingestion.`);
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
