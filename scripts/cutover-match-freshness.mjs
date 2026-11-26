import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, promisify } from 'node:util';
import { equalRun, MAX_STATE, positive, rewrapFlyCheckpoint, validateState } from './match-freshness-checkpoint.mjs';
import { boundedJSON, currentScopes } from './match-freshness-reader.mjs';

const repository = 'mcasillas17/ScoreArc';
const workflow = '.github/workflows/match-freshness.yml';
const repositoryId = 1284736122;
const workflowId = 362264580;
const root = `/repos/${repository}/actions`;
const databaseId = '31dcc498-699d-42ff-a051-f10e1534d0b5';
const databaseName = 'scorearc-alert-receiver';
const accountId = '4fcb63110aa75522b2636c923eeff468';
const config = fileURLToPath(new URL('../infra/alert-receiver/wrangler.jsonc', import.meta.url));
const reader = 'https://scorearc-reader.fly.dev';
const emptyRow = 'id=1 AND checkpoint IS NULL AND last_tick IS NULL AND lease_until=0';
const emptyDrainingRow = `${emptyRow} AND mode='draining'`;
const parkedRow = "id=1 AND mode='draining' AND checkpoint IS NOT NULL AND lease_until=0";
const timestamp = value => typeof value === 'string' ? Date.parse(value) : NaN;
class HandoffError extends Error {}
function requireValid(condition, message) {
  if (!condition) throw new HandoffError(message);
}

async function newestHead(github, now, workflowState) {
  const meta = await github(`${root}/workflows/match-freshness.yml`);
  requireValid(meta?.path === workflow && meta.id === workflowId && meta.state === workflowState,
    `Expected the production GitHub workflow to be ${workflowState}.`);
  const runs = `${root}/workflows/${workflowId}/runs`;
  // A queued older run or a rerun need not appear on the newest page. Check all
  // five nonterminal statuses across all runs. GitHub's status-only index can
  // report a nonzero total with no rows. Adding an all-history creation range
  // requests the dated search without excluding any workflow runs.
  for (const status of ['requested', 'waiting', 'pending', 'queued', 'in_progress']) {
    const page = await github(`${runs}?status=${status}&per_page=1&created=%3E%3D1970-01-01`);
    requireValid(page?.total_count === 0 && Array.isArray(page.workflow_runs) && page.workflow_runs.length === 0,
      'GitHub has an in-flight workflow run or incomplete run metadata.');
  }
  // A failed, skipped, or ambiguous newest main run is a barrier. Never fall
  // back to an older successful run whose history may have been superseded.
  const page = await github(`${runs}?branch=main&per_page=2`);
  requireValid(positive(page?.total_count) && Array.isArray(page.workflow_runs) &&
    page.workflow_runs.length === Math.min(2, page.total_count), 'Cannot identify newest main run.');
  const [run, previous] = page.workflow_runs;
  requireValid(run && positive(run.id) && positive(run.run_number) && run.run_attempt === 1 &&
    run.workflow_id === workflowId && [workflow, `${workflow}@main`, `${workflow}@refs/heads/main`].includes(run.path) &&
    run.head_branch === 'main' && /^[a-f0-9]{40}$/.test(run.head_sha) &&
    [run.repository, run.head_repository].every(repo => repo?.full_name === repository && repo.id === repositoryId) &&
    ['workflow_dispatch', 'schedule'].includes(run.event) && run.status === 'completed' && run.conclusion === 'success' &&
    timestamp(run.created_at) <= timestamp(run.updated_at) && timestamp(run.updated_at) <= now &&
    (!previous || (positive(previous.id) && previous.id < run.id && positive(previous.run_number) &&
      previous.run_number < run.run_number && timestamp(previous.created_at) <= timestamp(run.created_at))),
  'The newest main run has ambiguous provenance, chronology, attempt or completion.');
  return run;
}

async function finalArtifact(github, run, now, restored) {
  const url = `${root}/runs/${run.id}`;
  const jobs = await github(`${url}/attempts/1/jobs?per_page=10`);
  const job = jobs?.jobs?.[0];
  function completed(name, conclusion) {
    const matches = job.steps.filter(step => step.name === name);
    return matches.length === 1 && matches[0].status === 'completed' && matches[0].conclusion === conclusion;
  }
  requireValid(jobs?.total_count === 1 && jobs.jobs.length === 1 && job?.name === 'check' &&
    job.run_id === run.id && job.run_attempt === 1 && job.head_sha === run.head_sha &&
    job.status === 'completed' && job.conclusion === 'success' && Array.isArray(job.steps) &&
    ['Prepare pending state', 'Commit pending checkpoint before any send', 'Deliver reserved transitions',
      'Commit acknowledged checkpoint'].every(name => completed(name, 'success')) &&
    completed('Report data and monitor status separately', restored ? 'skipped' : 'success') &&
    (!restored || (run.event === 'workflow_dispatch' && completed('Fetch drained Fly checkpoint', 'success') &&
      completed('Select newest trusted checkpoint, including failed runs', 'skipped') && completed('Restore selected checkpoint', 'skipped'))),
  'The newest run did not complete the required checkpoint steps.');
  const page = await github(`${url}/artifacts?per_page=10`);
  requireValid(page?.total_count === 2 && page.artifacts?.length === 2, 'Expected both checkpoints from the newest run.');
  const pending = page.artifacts.find(a => a.name === 'match-freshness-pending');
  const final = page.artifacts.find(a => a.name === 'match-freshness-state');
  requireValid(pending && final && final.id !== pending.id && [pending, final].every(a => {
    const source = a.workflow_run;
    return positive(a.id) && positive(a.size_in_bytes) && a.size_in_bytes <= MAX_STATE &&
      a.expired === false && timestamp(a.expires_at) > now &&
      timestamp(a.created_at) >= timestamp(run.created_at) && timestamp(a.updated_at) >= timestamp(a.created_at) &&
      timestamp(a.updated_at) <= timestamp(run.updated_at) && source?.id === run.id && source.head_sha === run.head_sha &&
      source.head_branch === 'main' && source.repository_id === repositoryId && source.head_repository_id === repositoryId;
  }) && timestamp(pending.updated_at) <= timestamp(final.created_at) && /^sha256:[a-f0-9]{64}$/.test(final.digest),
  'Ambiguous, expired, incomplete or untrusted artifacts.');
  return final;
}

function onlyRow(response) {
  if (Array.isArray(response) && response.length === 1 && response[0]?.success === true &&
      response[0].results?.length === 1) return response[0].results[0];
}

async function preflightRuntime(query) {
  const schema = onlyRow(await query(`SELECT count(*) FILTER (WHERE name IN ('alert_event','monitor_heartbeat')) AS receiver,
    count(*) FILTER (WHERE name='monitor_runtime') AS runtime FROM sqlite_schema WHERE type='table'`));
  requireValid(schema?.receiver === 2 && [0, 1].includes(schema.runtime), 'Receiver database schema unavailable.');
  const runtime = schema.runtime ? 'github' : 'migration-required';
  if (schema.runtime) requireValid(onlyRow(await query(`SELECT id FROM monitor_runtime WHERE ${emptyRow} AND mode='github'`))?.id === 1,
    'Preflight requires GitHub ownership of the empty runtime row.');
  return runtime;
}

function validateFinal(state, run, artifact, scopes, now, restored) {
  const provenance = { repository, workflow, ref: 'refs/heads/main', id: run.id, number: run.run_number, attempt: 1, sha: run.head_sha };
  // GitHub rounds artifact timestamps to seconds; the runner records milliseconds.
  try {
    validateState(state, { baseURL: reader, run: provenance, scopes, now: Math.min(now, timestamp(artifact.created_at) + 999) });
  } catch { throw new HandoffError('Final checkpoint failed production schema, scope, sequence or clock validation.'); }
  requireValid(equalRun(state.run, provenance) && (restored || timestamp(state.updatedAt) >= timestamp(run.created_at)) &&
    state.version === 3 && state.phase === 'final' && !state.pending.length && !state.reserved.length && state.monitorFailure === null,
  'The final checkpoint must match this run and have fully acknowledged delivery.');
  return provenance;
}

async function verifyReceipts(query, state) {
  // Bind the artifact's ledger to the receiver that actually emailed these
  // events. An open incident can be older than the 32 receipts retained in v3.
  const receiptIds = [...new Set([...state.delivered.map(r => r.id), ...Object.values(state.incidents).filter(Boolean)])];
  const ledger = onlyRow(await query(`SELECT COALESCE(MAX(CAST(substr(event_id,instr(event_id,':')+1) AS INTEGER)),0) AS latest,
    count(*) FILTER (WHERE emailed_at IS NOT NULL AND event_id IN (SELECT value FROM json_each(?))) AS matched
    FROM alert_event WHERE event_id GLOB ?`, [JSON.stringify(receiptIds), state.epoch + ':*']));
  requireValid(ledger?.latest === state.sequence && ledger.matched === receiptIds.length,
    'The final checkpoint disagrees with the receiver event ledger.');
}

function verifyParked(frozen, lastTick, state, provenance, scopes, now) {
  let expected = frozen;
  if (frozen?.run?.fly) {
    requireValid(lastTick === frozen.run.tick, 'The parked Fly checkpoint does not match the last claimed tick.');
    try {
      expected = { ...rewrapFlyCheckpoint(frozen, { baseURL: reader, run: provenance, scopes, now }), phase: 'final' };
    } catch { throw new HandoffError('Parked Fly checkpoint failed validation.'); }
  }
  requireValid(isDeepStrictEqual(expected, state), 'The newest final artifact and parked checkpoint contain different history.');
}

export async function cutover(args, { github, info, query, download, scopes, clock }) {
  const command = args[0];
  const rollback = ['rollback-check', 'rollback-apply'].includes(command);
  const applying = ['apply', 'rollback-apply'].includes(command);
  const preflight = command === 'preflight';
  requireValid(['preflight', 'check', 'rollback-check'].includes(command) && args.length === 1 ||
    applying && args.length === 3 && args.slice(1).every(id => /^[1-9][0-9]*$/.test(id) && positive(Number(id))),
  'Usage: node scripts/cutover-match-freshness.mjs preflight | check | apply RUN_ID ARTIFACT_ID | rollback-check | rollback-apply RUN_ID ARTIFACT_ID');
  const target = await info();
  requireValid(target?.uuid === databaseId && target.name === databaseName, 'Receiver database binding or identity mismatch.');
  let runtime = 'draining';
  let parked;
  if (preflight) {
    runtime = await preflightRuntime(query);
  } else if (rollback) {
    parked = onlyRow(await query(`SELECT last_tick,checkpoint FROM monitor_runtime WHERE ${parkedRow}`));
    requireValid(typeof parked?.checkpoint === 'string', 'Park the settled checkpoint before returning ownership.');
  } else {
    requireValid(onlyRow(await query(`SELECT id FROM monitor_runtime WHERE ${emptyDrainingRow}`))?.id === 1,
      'Receiver must be draining, unclaimed and empty before a first import.');
  }
  const frozen = parked && JSON.parse(parked.checkpoint);
  // If Fly has yet to commit a checkpoint, the original disabled Actions run
  // still owns this exact artifact. No restore dispatch is needed in that case.
  const restored = Boolean(frozen?.run?.fly);
  const workflowState = preflight || restored ? 'active' : 'disabled_manually';
  const run = await newestHead(github, clock(), workflowState);
  const artifact = await finalArtifact(github, run, clock(), restored);
  requireValid(!applying || (String(run.id) === args[1] && String(artifact.id) === args[2]),
    'Newest run or final artifact differs from the reviewed IDs. Repeat check.');
  const state = await download(artifact);
  const provenance = validateFinal(state, run, artifact, scopes, clock(), restored);
  await verifyReceipts(query, state);
  if (rollback) verifyParked(frozen, parked.last_tick, state, provenance, scopes, clock());
  if (applying) {
    // Recheck the source after download/validation, immediately before the single
    // conditional write. The parked-row comparison also fences operator races.
    const head = await newestHead(github, clock(), workflowState);
    requireValid(head.id === run.id && head.head_sha === run.head_sha && head.updated_at === run.updated_at &&
      isDeepStrictEqual(await finalArtifact(github, head, clock(), restored), artifact), 'GitHub changed during handoff. Repeat check.');
    const changed = rollback
      ? await query(`UPDATE monitor_runtime SET mode='github', checkpoint=NULL, last_tick=NULL WHERE ${parkedRow}
          AND last_tick IS ? AND checkpoint=? RETURNING id`, [parked.last_tick, parked.checkpoint])
      : await query(`UPDATE monitor_runtime SET checkpoint=?, mode='fly' WHERE ${emptyDrainingRow} RETURNING id`, [JSON.stringify(state)]);
    requireValid(onlyRow(changed)?.id === 1, 'Receiver changed during handoff. Inspect runtime state before retrying.');
    runtime = rollback ? 'github' : 'fly';
  }
  return { status: command, runtime, workflowState, databaseId, runId: run.id, artifactId: artifact.id,
    artifactDigest: artifact.digest, epoch: state.epoch, sequence: state.sequence, openIncidents: Object.values(state.incidents).filter(Boolean).length,
    receipts: state.delivered.length, scopes: scopes.length };
}

export async function readArchive(archive, artifact, dir, binary) {
  requireValid(archive.length === artifact.size_in_bytes &&
    'sha256:' + createHash('sha256').update(archive).digest('hex') === artifact.digest, 'Artifact digest or size mismatch.');
  const path = join(dir, 'artifact.zip');
  await writeFile(path, archive, { flag: 'wx', mode: 0o600 });
  requireValid((await binary('unzip', ['-Z1', path])).toString() === 'state.json\n', 'Expected exactly one archived state.json.');
  return JSON.parse((await binary('unzip', ['-p', path, 'state.json'], MAX_STATE)).toString());
}

function authHeaders(credentials) {
  if (['oauth', 'api_token'].includes(credentials?.type) && credentials.token) {
    return { Authorization: `Bearer ${credentials.token}` };
  }
  if (credentials?.type === 'api_key' && credentials.email && credentials.key) {
    return { 'X-Auth-Email': credentials.email, 'X-Auth-Key': credentials.key };
  }
  throw new HandoffError('Wrangler did not supply a supported Cloudflare credential.');
}

export async function receiverDatabase(wrangler) {
  const info = await wrangler(['d1', 'info', 'DB']);
  const deployment = await wrangler(['deployments', 'status', '--name', databaseName]);
  requireValid(Array.isArray(deployment?.versions) && deployment.versions.length > 0 &&
    deployment.versions.every(v => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v.version_id) &&
      Number.isFinite(v.percentage) && v.percentage >= 0) &&
    deployment.versions.reduce((total, v) => total + v.percentage, 0) === 100, 'Unknown receiver traffic allocation.');
  for (const version of deployment.versions.filter(v => v.percentage > 0)) {
    const details = await wrangler(['versions', 'view', version.version_id, '--name', databaseName]);
    const matches = details?.resources?.bindings?.filter(b => b.name === 'DB');
    requireValid(details?.id === version.version_id && matches?.length === 1 && matches[0].type === 'd1' &&
      (matches[0].database_id ?? matches[0].id) === databaseId, 'A deployed receiver version has the wrong DB binding.');
  }
  return info;
}

// The REST query endpoint binds JSON as data. Wrangler's --command takes the
// full SQL in argv, and --file uses D1's database-wide bulk import operation.
export async function queryReceiver(sql, params, credentials, fetchImpl = fetch) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', ...authHeaders(credentials) }, body: JSON.stringify({ sql, params }) });
  requireValid(response.ok && !response.redirected, 'D1 query failed. Inspect runtime mode before retrying.');
  // A parked checkpoint is JSON inside a D1 result string with escaped quotes.
  const data = await boundedJSON(response, 2 * MAX_STATE + 16 * 1024);
  requireValid(data?.success === true, 'D1 query failed. Inspect runtime mode before retrying.');
  return data.result;
}

const runFile = promisify(execFile);
async function cli(args) {
  const dir = await mkdtemp(join(tmpdir(), 'scorearc-cutover-'));
  try {
    // Never relay child stderr, command arguments or JSON parse errors. Some
    // contain provider responses, signed download URLs or the checkpoint.
    const env = { ...process.env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG_PATH: dir, WRANGLER_LOG_SANITIZE: 'true', GH_PROMPT_DISABLED: '1' };
    const binary = async (cmd, argv, maxBuffer = 1024 * 1024) =>
      (await runFile(cmd, argv, { encoding: 'buffer', env, maxBuffer, timeout: 30_000 })).stdout;
    const github = async path => JSON.parse((await binary('gh', ['api', '--hostname', 'github.com', path])).toString());
    const wrangler = async argv => JSON.parse((await binary('wrangler', [...argv, '--config', config, '--json'])).toString());
    const download = async artifact => {
      const archive = await binary('gh', ['api', '--hostname', 'github.com', `${root}/artifacts/${artifact.id}/zip`], MAX_STATE);
      return readArchive(archive, artifact, dir, binary);
    };
    const scopes = currentScopes(JSON.parse(await readFile(new URL('../backend/config/competitions.json', import.meta.url), 'utf8')));
    const credentials = await wrangler(['auth', 'token']);
    return await cutover(args, { github, info: () => receiverDatabase(wrangler), query: (sql, params = []) => queryReceiver(sql, params, credentials),
      download, scopes, clock: Date.now });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await cli(process.argv.slice(2)))); }
  catch (error) {
    console.error(error instanceof HandoffError ? error.message : 'Handoff failed at a CLI, artifact or database boundary. Inspect runtime mode before retrying.');
    process.exitCode = 1;
  }
}
