const REPOSITORY = 'mcasillas17/ScoreArc';
const WORKFLOW = '.github/workflows/match-freshness.yml';
const MAX_STATE_BYTES = 256 * 1024;
const MAX_API_BYTES = 1024 * 1024;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}
function timestamp(value) {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}
function list(response, key, limit, complete = true) {
  requireValid(response && Number.isSafeInteger(response.total_count) && response.total_count >= 0
    && Array.isArray(response[key]) && response[key].length <= limit
    && response[key].length <= response.total_count
    && (!complete || response[key].length === response.total_count), `Incomplete or invalid ${key} history exceeds bounds`);
  return response[key];
}

/** Read fixed-origin GitHub JSON, including the response body within the deadline. */
export function githubJSON(token) {
  requireValid(typeof token === 'string' && token.length > 0, 'GitHub API token is required');
  return async (path) => {
    requireValid(typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !path.includes('\\'), 'Invalid GitHub API path');
    const url = new URL(path, 'https://api.github.com');
    requireValid(url.origin === 'https://api.github.com' && !url.hash, 'Invalid GitHub API origin');
    const controller = new AbortController();
    let reader;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('GitHub API request timed out'));
        controller.abort();
        void reader?.cancel().catch(() => {});
      }, 10_000);
    });
    const request = async () => {
      const response = await fetch(url.href, {
        redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      requireValid(response.ok && !response.redirected && response.body, 'GitHub API request failed');
      const length = response.headers.get('content-length');
      requireValid(length === null || (/^\d+$/.test(length) && Number(length) <= MAX_API_BYTES), 'GitHub API response exceeds size limit');
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        requireValid(size <= MAX_API_BYTES, 'GitHub API response exceeds size limit');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    };
    try {
      return await Promise.race([request(), deadline]);
    } catch (error) {
      // GitHub or fetch errors may contain response bodies, URLs or credentials.
      const safe = ['GitHub API request timed out', 'GitHub API response exceeds size limit'];
      throw new Error(safe.includes(error?.message) ? error.message : 'GitHub API request failed');
    } finally {
      clearTimeout(timer);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  };
}

/** Select metadata only. The caller must download and validate the v2 envelope. */
export async function selectState({ github, run, initialize = false, now = Date.now() }) {
  requireValid(run && run.repository === REPOSITORY && run.workflow === WORKFLOW
    && run.ref === 'refs/heads/main' && positive(run.id) && positive(run.number)
    && run.attempt === 1 && sha(run.sha) && Number.isFinite(now)
    && typeof initialize === 'boolean' && typeof github === 'function', 'Invalid current monitor run provenance');
  const root = `/repos/${REPOSITORY}/actions`;
  const workflow = await github(`${root}/workflows/match-freshness.yml`);
  requireValid(workflow && positive(workflow.id) && workflow.path === WORKFLOW, 'Invalid trusted workflow metadata');
  const current = await github(`${root}/runs/${run.id}`);
  const repositoryId = current?.repository?.id;
  function validateRun(source) {
    requireValid(source && positive(source.id) && positive(source.run_number) && source.run_attempt === 1
      && source.workflow_id === workflow.id && [WORKFLOW, `${WORKFLOW}@main`, `${WORKFLOW}@refs/heads/main`].includes(source.path) && source.head_branch === 'main'
      && sha(source.head_sha) && ['schedule', 'workflow_dispatch'].includes(source.event)
      && positive(repositoryId) && source.repository?.id === repositoryId && source.repository.full_name === REPOSITORY
      && source.head_repository?.id === repositoryId && source.head_repository.full_name === REPOSITORY
      && Number.isFinite(timestamp(source.created_at)) && timestamp(source.created_at) <= now
      && timestamp(source.updated_at) >= timestamp(source.created_at) && timestamp(source.updated_at) <= now,
    'Invalid workflow run provenance or chronology');
  }
  async function loadJobs(source) {
    const jobs = list(await github(`${root}/runs/${source.id}/attempts/1/jobs?per_page=10`), 'jobs', 10);
    requireValid(jobs.length > 0, 'Missing job history cannot prove checkpoint status');
    const ids = new Set();
    for (const job of jobs) {
      requireValid(job && positive(job.id) && !ids.has(job.id) && job.run_id === source.id
        && (job.run_attempt === undefined || job.run_attempt === 1)
        && job.status === 'completed' && Array.isArray(job.steps) && job.steps.length <= 100,
      'Invalid checkpoint job provenance');
      ids.add(job.id);
    }
    return jobs;
  }
  validateRun(current);
  requireValid(current.id === run.id && current.run_number === run.number && current.head_sha === run.sha,
    'Current workflow run does not match invocation');
  let previousNumber = run.number + 1;
  let previousCreated = timestamp(current.created_at);
  let enumerated = 0;
  let total;
  const seenIds = new Set();
  for (let page = 1; page <= 3; page++) {
    const response = await github(`${root}/workflows/${workflow.id}/runs?branch=main&per_page=20&page=${page}`);
    const runs = list(response, 'workflow_runs', 20, false);
    total ??= response.total_count;
    requireValid(total === response.total_count && enumerated + runs.length <= total, 'Changing workflow run history');
    // Validate the complete page before accepting an artifact, so reordered results cannot hide a newer run.
    for (const source of runs) {
      validateRun(source);
      const isCurrent = source.id === run.id;
      requireValid(!seenIds.has(source.id) && source.run_number < previousNumber
        && source.run_number <= run.number && timestamp(source.created_at) <= previousCreated
        && (isCurrent ? source.run_number === run.number && source.head_sha === run.sha
          : source.run_number < run.number && source.id < run.id && source.status === 'completed'
            && timestamp(source.created_at) < timestamp(current.created_at)), 'Invalid or nonmonotonic workflow run history');
      seenIds.add(source.id);
      previousNumber = source.run_number;
      previousCreated = timestamp(source.created_at);
    }
    for (const source of runs) {
      if (source.id === run.id) continue;
      const artifacts = list(await github(`${root}/runs/${source.id}/artifacts?per_page=10`), 'artifacts', 10);
      const checkpoints = artifacts.filter((item) => ['match-freshness-state', 'match-freshness-pending'].includes(item?.name));
      if (checkpoints.length) {
        requireValid(!initialize, 'Initialization is forbidden when durable state exists');
        const names = new Set();
        const ids = new Set();
        for (const item of checkpoints) {
          const origin = item.workflow_run;
          requireValid(!names.has(item.name) && !ids.has(item.id) && positive(item.id)
            && item.expired === false && Number.isSafeInteger(item.size_in_bytes) && item.size_in_bytes > 0
            && item.size_in_bytes <= MAX_STATE_BYTES && timestamp(item.expires_at) > now
            && timestamp(item.created_at) >= timestamp(source.created_at)
            && timestamp(item.updated_at) >= timestamp(item.created_at)
            && timestamp(item.updated_at) <= timestamp(source.updated_at)
            && origin?.id === source.id && origin.repository_id === repositoryId && origin.head_repository_id === repositoryId
            && origin.head_branch === 'main' && origin.head_sha === source.head_sha, 'Invalid, expired or ambiguous newest checkpoint');
          names.add(item.name);
          ids.add(item.id);
        }
        const final = checkpoints.find((item) => item.name === 'match-freshness-state');
        const pending = checkpoints.find((item) => item.name === 'match-freshness-pending');
        // API timestamps can share a second; final must never predate pending completion.
        requireValid(!final || !pending || timestamp(final.created_at) >= timestamp(pending.updated_at),
          'Invalid checkpoint chronology: final predates pending');
        if (!final) {
          const jobs = await loadJobs(source);
          const commits = jobs.flatMap((job) => job.steps.filter((step) => step?.name === 'Commit acknowledged checkpoint'));
          requireValid(commits.length === 1 && commits[0].status === 'completed'
            && ['skipped', 'failure'].includes(commits[0].conclusion),
          'Missing final checkpoint after successful or ambiguous acknowledged upload');
        }
        const selected = final ?? pending;
        return { run: { repository: REPOSITORY, workflow: WORKFLOW, ref: 'refs/heads/main', id: source.id,
          number: source.run_number, attempt: source.run_attempt, sha: source.head_sha }, artifactId: selected.id, artifactName: selected.name };
      }
      const jobs = await loadJobs(source);
      for (const job of jobs) {
        if (job.conclusion === 'skipped' && job.steps.length === 0) continue;
        const prepare = job.steps.filter((step) => step?.name === 'Prepare pending state');
        requireValid(prepare.length === 1 && prepare[0].status === 'completed' && prepare[0].conclusion === 'skipped',
          'Missing checkpoint after attempted or unproven preparation');
      }
    }
    enumerated += runs.length;
    if (enumerated === total) {
      requireValid(initialize, 'No durable state; explicit initialization is required');
      return null;
    }
    requireValid(runs.length === 20, 'Incomplete workflow run history');
  }
  throw new Error('Workflow run history exceeds bounded search budget');
}
