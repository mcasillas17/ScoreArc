import { mkdir, open, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { checkScope, boundedJSON, exact } from './match-freshness-reader.mjs';
import { equalRun, finishGitHubCheckpoint, MAX_STATE, positive, prepareGitHubCheckpoint, rewrapCloudflareCheckpoint, validateGitHubConfig, validateRun, validateState } from './match-freshness-checkpoint.mjs';
import { downloadCloudflareCheckpoint, SEND_TIMEOUT_MS, sendHeartbeat, webhook } from './match-freshness-receiver.mjs';
export { sendHeartbeat } from './match-freshness-receiver.mjs';
export { validateRun, validateState } from './match-freshness-checkpoint.mjs';

async function load(path) {
  try {
    const file = await open(path, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_STATE) throw new Error('size');
      const buffer = Buffer.alloc(MAX_STATE + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_STATE) throw new Error('size');
      return JSON.parse(buffer.toString('utf8', 0, bytesRead));
    } finally { await file.close(); }
  } catch (cause) { throw new Error('State unavailable or corrupt; refusing reset', { cause }); }
}
async function save(path, state) {
  const bytes = JSON.stringify(state) + '\n';
  if (Buffer.byteLength(bytes) > MAX_STATE) throw new Error('State size exceeded');
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
async function locked(path, operation) {
  if (typeof path !== 'string' || !path) throw new Error('Invalid state path');
  const lock = `${path}.lock`;
  try { await mkdir(lock); } catch { throw new Error('State lock unavailable'); }
  try {
    await writeFile(`${lock}/owner`, String(process.pid), { flag: 'wx' });
    return await operation();
  } finally { await rm(`${lock}/owner`, { force: true }); await rmdir(lock); }
}
const outcome = s => ({ exitCode: s.monitorFailure || s.pending.length ? 2 : s.dataIncident ? 1 : 0, pending: s.pending.length, monitorFailure: s.monitorFailure });

export async function prepareMonitor(options) {
  if (options.enabled !== true) return { disabled: true };
  validateGitHubConfig(options);
  const { stateFile, initialize = false } = options;
  return locked(stateFile, async () => {
    if (initialize) {
      // Never overwrite existing history even when an operator repeats init.
      try { await open(stateFile, 'r').then(async f => { await f.close(); throw new Error('State already exists'); }); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const previous = initialize ? null : await load(stateFile);
    const state = await prepareGitHubCheckpoint(previous, options);
    await save(stateFile, state);
    return outcome(state);
  });
}
function parseExplicitRecovery(env) {
  const runId = env.RECOVERY_RUN_ID ?? '';
  const artifactId = env.RECOVERY_ARTIFACT_ID ?? '';
  if (runId === '' && artifactId === '') return null;
  if (!/^[1-9][0-9]{0,15}$/.test(runId) || !/^[1-9][0-9]{0,15}$/.test(artifactId)) throw new Error('Invalid explicit recovery configuration');
  const recovery = { runId: Number(runId), artifactId: Number(artifactId) };
  if (!positive(recovery.runId) || !positive(recovery.artifactId)) throw new Error('Invalid explicit recovery configuration');
  return recovery;
}
export async function deliverMonitor(options) {
  if (options.enabled !== true || options.deliveryEnabled !== true) return { disabled: true };
  validateGitHubConfig(options);
  if (!positive(options.pendingArtifactId)) throw new Error('Pending checkpoint upload required');
  const url = webhook(options.webhookURL);
  const timeoutMs = options.timeoutMs ?? SEND_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SEND_TIMEOUT_MS) throw new Error('Invalid notifier timeout');
  return locked(options.stateFile, async () => {
    const send = async notification => {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await (options.fetchImpl ?? fetch)(url, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': notification.eventId }, body: JSON.stringify(notification) });
        if (response.status !== 200) throw new Error('not-acknowledged');
        const ack = await boundedJSON(response, 1024);
        if (!exact(ack, 'eventId') || ack.eventId !== notification.eventId) throw new Error('not-acknowledged');
      } finally { clearTimeout(timer); controller.abort(); }
    };
    const final = await finishGitHubCheckpoint(await load(options.stateFile), { ...options, send });
    await save(options.stateFile, final);
    return outcome(final);
  });
}

// The CLI phases mirror the artifact boundaries in match-freshness.yml. A phase
// writes outputs only after a new validated state has been atomically saved.
export async function runPhase({ phase, env = process.env, workDir = 'watchdog-state', now, baseURL = 'https://scorearc-reader.fly.dev', github, check = checkScope, fetchImpl = fetch }) {
  if (env.MATCH_FRESHNESS_ENABLED !== 'true') {
    console.log('Match monitor disabled; no checks or delivery.'); return { exitCode: 0 };
  }
  const clock = now === undefined ? Date.now : () => now;
  now = clock();
  const { appendFile, readFile } = await import('node:fs/promises');
  const { currentScopes } = await import('./match-freshness-watchdog.mjs');
  const { githubJSON, selectState } = await import('./match-freshness-state.mjs');
  const run = { repository: env.GITHUB_REPOSITORY, workflow: '.github/workflows/match-freshness.yml', ref: env.GITHUB_REF,
    id: Number(env.GITHUB_RUN_ID), number: Number(env.GITHUB_RUN_NUMBER), attempt: Number(env.GITHUB_RUN_ATTEMPT), sha: env.GITHUB_SHA };
  validateRun(run);
  const output = async values => {
    if (!env.GITHUB_OUTPUT) throw new Error('Missing workflow output');
    await appendFile(env.GITHUB_OUTPUT, Object.entries(values).map(([k,v]) => `${k}=${v}\n`).join(''));
  };
  const { join } = await import('node:path');
  const stateFile = join(workDir, 'state.json');
  const selectionFile = join(workDir, 'selection.json');
  if (phase === 'select') {
    const initialize = env.INITIALIZE_STATE === 'true';
    if (!['true','false'].includes(env.INITIALIZE_STATE)) throw new Error('Explicit initialization choice required');
    const selection = await selectState({ github: github ?? githubJSON(env.GITHUB_TOKEN), run, initialize, recovery: parseExplicitRecovery(env), now });
    await mkdir(workDir, { recursive: true });
    await writeFile(selectionFile, JSON.stringify(selection), { flag: 'wx', mode: 0o600 });
    await output({ initialize: selection === null, artifact_id: selection?.artifactId ?? '', run_id: selection?.run.id ?? '' });
    return { exitCode: 0 };
  }
  const registry = JSON.parse(await readFile(new URL('../backend/config/competitions.json', import.meta.url), 'utf8'));
  const options = { enabled: true, deliveryEnabled: env.MATCH_FRESHNESS_DELIVERY_ENABLED === 'true',
    baseURL, scopes: currentScopes(registry), stateFile, run, now, clock };
  const rollbackFile = join(workDir, 'cloudflare.json');
  if (phase === 'restore-cloudflare') {
    const checkpoint = await downloadCloudflareCheckpoint(env, options, fetchImpl);
    await mkdir(workDir, { recursive: true });
    await writeFile(rollbackFile, JSON.stringify(checkpoint), { flag: 'wx', mode: 0o600 });
    await output({ fetched: true });
  } else if (phase === 'prepare' && env.RESTORE_FROM_CLOUDFLARE === 'true') {
    const pending = rewrapCloudflareCheckpoint(await load(rollbackFile), options);
    await save(stateFile, pending);
    await output({ state_written: true });
  } else if (phase === 'prepare') {
    const selection = JSON.parse(await readFile(selectionFile, 'utf8'));
    await prepareMonitor({ ...options, initialize: selection === null, restoredRun: selection?.run, check,
      onObservation: (scope, result, cause) => {
        const name = registry.find(comp => comp.id === scope.competition).name;
        console.log(`${cause ? 'UNHEALTHY' : 'OK'} ${name} | ${result.context}${cause ? ` cause=${cause}` : ''}`);
      },
    });
    await output({ state_written: true });
  } else if (phase === 'deliver') {
    const result = await deliverMonitor({ ...options, webhookURL: env.MATCH_FRESHNESS_WEBHOOK_URL,
      pendingArtifactId: Number(env.PENDING_ARTIFACT_ID) });
    if (!result.disabled) await output({ state_written: true });
  } else if (phase === 'result') {
    const state = validateState(await load(stateFile), options);
    if (!equalRun(state.run, run)) throw new Error('State result provenance mismatch');
    const result = outcome(state);
    console.log(`Match monitor: data_incident=${state.dataIncident} pending=${result.pending} monitor=${result.monitorFailure ?? 'ok'}`);
    // A delivered data incident is not a failed job. The receiver already sent
    // the alert; failing every five-minute run sends unrelated GitHub failure mail.
    if (result.exitCode < 2 && options.deliveryEnabled && env.CHECKPOINT_COMMITTED === 'true') {
      try {
        await sendHeartbeat({ webhookURL: env.MATCH_FRESHNESS_WEBHOOK_URL });
        console.log('Match monitor heartbeat acknowledged.');
      } catch {
        console.error('Match monitor heartbeat not acknowledged; check the alert receiver logs.');
      }
    }
    return result.exitCode === 1 && options.deliveryEnabled && env.CHECKPOINT_COMMITTED === 'true'
      ? { ...result, exitCode: 0 } : result;
  } else throw new Error('Invalid monitor phase');
  return { exitCode: 0 };
}
const { resolve } = await import('node:path');
const { fileURLToPath } = await import('node:url');
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runPhase({ phase: process.argv[2] }).then(result => { process.exitCode = result.exitCode; }).catch(() => {
    console.error('Match monitor failed: configuration, state, API, persistence or delivery boundary. Incident history was not reset.');
    process.exitCode = 2;
  });
}
