import { appendFile, mkdir, open, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { checkScope, currentScopes, exact, MAX_SCOPES, origin, record, scopeKey } from './match-freshness-reader.mjs';
export { boundedJSON, checkScope, CONTRACT_KEYS, currentScopes, origin, scopeKey } from './match-freshness-reader.mjs';

const MAX_STATE_BYTES = 32768;

async function readState(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error('Invalid state size');
    const buffer = Buffer.alloc(MAX_STATE_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_STATE_BYTES) throw new Error('Invalid state size');
    return JSON.parse(buffer.toString('utf8', 0, bytesRead));
  } finally {
    await file.close();
  }
}

// Single-flight on a local durable filesystem. A stale lock fails closed; an
// operator must verify no run is active before removing it.
export async function runWatchdog({ baseURL, scopes, stateFile, initialize = false, timeoutMs = 10000, onStateWritten = () => {} }) {
  const base = origin(baseURL);
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > MAX_SCOPES) throw new Error('Invalid scopes');
  const keys = scopes.map(scopeKey).sort();
  if (new Set(keys).size !== keys.length || typeof stateFile !== 'string' || !stateFile) throw new Error('Invalid state/scopes');
  const lock = `${stateFile}.lock`;
  try { await mkdir(lock); } catch { throw new Error('State lock unavailable'); }
  const temp = `${stateFile}.tmp-${randomUUID()}`;
  try {
    let state;
    try {
      state = await readState(stateFile);
    } catch (error) {
      if (error.code !== 'ENOENT' || !initialize) throw new Error('State unavailable or corrupt; refusing reset');
      state = { version: 1, origin: base, incidents: Object.fromEntries(keys.map(key => [key, false])) };
    }
    if (!exact(state, 'version origin incidents') || state.version !== 1 || state.origin !== base ||
        !record(state.incidents) || Object.keys(state.incidents).sort().join(',') !== keys.join(',') ||
        !Object.values(state.incidents).every(value => typeof value === 'boolean')) {
      throw new Error('Invalid state contract or changed scopes/origin; refusing reset');
    }
    const messages = [];
    let exitCode = 0;
    for (const scope of scopes) {
      const result = await checkScope({ baseURL: base, ...scope, timeoutMs });
      const key = scopeKey(scope);
      const incident = !result.ok;
      if (incident !== state.incidents[key]) messages.push(`${incident ? 'OPEN' : 'RESOLVED'} ${result.context}`);
      state.incidents[key] = incident;
      if (incident) exitCode = 1;
    }
    // Bound is independent of time/run count: exactly one boolean per scope.
    await writeFile(temp, JSON.stringify(state)+'\n', { flag: 'wx', mode: 0o600 });
    await rename(temp, stateFile);
    // Signal the durable write before cleanup, which may itself fail.
    onStateWritten();
    return { exitCode, messages };
  } finally {
    await rm(temp, { force: true });
    await rmdir(lock);
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    'base-url': { type: 'string', default: 'https://scorearc-reader.fly.dev' },
    'state-file': { type: 'string' },
    'init-state': { type: 'boolean', default: false },
  } });
  if (!values['state-file']) throw new Error('--state-file is required');
  const registry = JSON.parse(await readFile(new URL('../backend/config/competitions.json', import.meta.url), 'utf8'));
  let stateWritten = false;
  try {
    const result = await runWatchdog({
      baseURL: values['base-url'], stateFile: values['state-file'],
      initialize: values['init-state'], scopes: currentScopes(registry),
      onStateWritten: () => { stateWritten = true; },
    });
    for (const message of result.messages) console.log(message);
    process.exitCode = result.exitCode;
  } finally {
    // A failed check can still produce valid incident state. Do not publish a
    // merely restored, corrupt, or absent file as if it were a newly saved one.
    if (stateWritten && process.env.GITHUB_OUTPUT) {
      await appendFile(process.env.GITHUB_OUTPUT, 'state_written=true\n');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Watchdog failed: configuration, durable state, or persistence unavailable. No silent reset.');
    process.exitCode = 2;
  });
}
