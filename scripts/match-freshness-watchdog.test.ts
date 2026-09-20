import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type RequestListener, type Server } from 'node:http';
import { mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { checkScope, currentScopes, runWatchdog } from './match-freshness-watchdog.mjs';

const scope = { competition: 'world-cup', season: '2026' };
const validHeaders = {
  'Content-Type': 'application/json',
  'X-ScoreArc-Freshness': 'fresh',
  'X-ScoreArc-Observed-At': '2026-09-19T08:00:00Z',
  'X-ScoreArc-Poll-Status': 'ok',
  'X-ScoreArc-Stale-Matches': '0',
  'X-ScoreArc-Overdue-Matches': '0',
};
const match = {
  id: '018f0000-0000-7000-8000-000000000001', kickoff: '2026-09-19T07:00:00Z',
  state: 'live', minute: "4'", statusDetail: "4'", statusName: 'STATUS_IN_PROGRESS',
  home: { id: 'arg', name: 'Argentina', abbr: 'ARG', crestUrl: null },
  away: { id: 'fra', name: 'France', abbr: 'FRA', crestUrl: null },
  homeScore: 0, awayScore: 0, winnerId: null, note: null,
  scorers: [], cards: [], shootout: null, shootoutDetail: null, stats: null, winProbability: null,
};
const servers: Server[] = [];
const dirs: string[] = [];
type Workflow = {
  on: { workflow_dispatch: { inputs: Record<string, { type: string; required?: boolean; default?: boolean }> } };
  jobs: { check: { steps: { id?: string; uses?: string; if?: string; run?: string; env?: Record<string, string>; with?: Record<string, string> }[] } };
};
const yaml = createRequire(import.meta.url)('js-yaml') as { load(source: string): Workflow };
async function watchdogWorkflow() {
  return yaml.load(await readFile('.github/workflows/match-freshness.yml', 'utf8'));
}
function shell(script: string, env: Record<string, string>, cwd = process.cwd()) {
  return new Promise<{ code: number; stdout: string }>(resolve => {
    execFile('bash', ['-e', '-o', 'pipefail', '-c', script], { cwd, env: { ...process.env, ...env } },
      (error, stdout) => resolve({ code: typeof error?.code === 'number' ? error.code : error ? -1 : 0, stdout }));
  });
}
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing listener');
  return `http://127.0.0.1:${address.port}`;
}
async function stateFile() {
  const dir = await mkdtemp(join(tmpdir(), 'scorearc-watchdog-'));
  dirs.push(dir);
  return join(dir, 'state.json');
}

describe('bounded match freshness watchdog', () => {
  it('declares the installed YAML parser directly rather than relying on transitive hoisting', async () => {
    const installed = createRequire(import.meta.url)('js-yaml/package.json') as { version: string };
    const manifest = JSON.parse(await readFile('package.json', 'utf8')) as { devDependencies: Record<string, string> };
    const lock = JSON.parse(await readFile('package-lock.json', 'utf8')) as {
      packages: Record<string, { version?: string; devDependencies?: Record<string, string> }>;
    };
    expect(manifest.devDependencies['js-yaml']).toBe(installed.version);
    expect(lock.packages[''].devDependencies?.['js-yaml']).toBe(installed.version);
    expect(lock.packages['node_modules/js-yaml'].version).toBe(installed.version);
  });
  it('uses existing scoped matches route and revalidates, no ingester dependency', async () => {
    const baseURL = await serve((req, res) => {
      expect(req.url).toBe('/v1/competitions/world-cup/2026/matches');
      expect(req.headers['cache-control']).toContain('no-cache');
      res.writeHead(200, validHeaders).end(JSON.stringify([match]));
    });
    const result = await checkScope({ baseURL, ...scope });
    expect(result.ok).toBe(true);
    expect(result.count).toBe(1);
  });
  it('accepts the actual scored-match and shootout detail field names', async () => {
    const populated = {
      ...match,
      scorers: [{ teamId: 'arg', player: 'Player', minute: "4'", penalty: false, shootout: false }],
      cards: [{ teamId: 'fra', player: 'Player', minute: "5'", type: 'yellow' }],
      shootout: { homeScore: 4, awayScore: 3 },
      shootoutDetail: {
        home: [{ order: 1, player: 'Player', scored: true }],
        away: [{ order: 1, player: 'Player', scored: false }],
      },
      winProbability: { home: 30, draw: 30, away: 40 },
    };
    const baseURL = await serve((_req, res) => res.writeHead(200, validHeaders).end(JSON.stringify([populated])));
    expect((await checkScope({ baseURL, ...scope })).ok).toBe(true);
  });
  it.each([
    { 'X-ScoreArc-Freshness': 'stale', 'X-ScoreArc-Stale-Matches': '1', 'X-ScoreArc-Overdue-Matches': '1' },
    { 'X-ScoreArc-Freshness': 'unavailable' },
    { 'X-ScoreArc-Poll-Status': 'partial' },
    { 'X-ScoreArc-Poll-Status': 'failed' },
  ])('detects unhealthy response %j', async override => {
    const baseURL = await serve((_req, res) => res.writeHead(200, { ...validHeaders, ...override }).end(JSON.stringify([match])));
    const result = await checkScope({ baseURL, ...scope });
    expect(result.ok).toBe(false);
    expect(result.context).toContain('world-cup/2026');
    expect(result.context).toContain('matches=1');
  });
  it.each([
    {}, { matches: [match] }, null, [{}], [{ ...match, state: 'stale' }],
    [{ ...match, id: '' }], [{ ...match, kickoff: 'not-a-date' }],
    [{ ...match, homeScore: -1 }], [{ ...match, home: {} }], [{ ...match, cards: null }],
    [{ ...match, extra: true }], [match, match],
  ])('rejects body contract violations %j', async body => {
    const baseURL = await serve((_req, res) => res.writeHead(200, validHeaders).end(JSON.stringify(body)));
    expect((await checkScope({ baseURL, ...scope })).ok).toBe(false);
  });
  it('rejects count contradictions, missing headers, malformed JSON and HTTP errors', async () => {
    for (const candidate of [
      { headers: validHeaders, status: 503, body: '[]' },
      { headers: { 'Content-Type': 'application/json' }, status: 200, body: '[]' },
      { headers: validHeaders, status: 200, body: '{' },
      { headers: { ...validHeaders, 'X-ScoreArc-Freshness': 'stale', 'X-ScoreArc-Stale-Matches': '3' }, status: 200, body: JSON.stringify([match]) },
      { headers: { ...validHeaders, 'X-ScoreArc-Freshness': 'empty' }, status: 200, body: JSON.stringify([match]) },
      { headers: validHeaders, status: 200, body: '[]' },
    ]) {
      const baseURL = await serve((_req, res) => res.writeHead(candidate.status, candidate.headers).end(candidate.body));
      expect((await checkScope({ baseURL, ...scope })).ok).toBe(false);
    }
  });
  it('rejects healthy headers that contradict unresolved matches', async () => {
    for (const override of [
      { 'X-ScoreArc-Poll-Status': 'unknown' },
      { 'X-ScoreArc-Freshness': 'dormant' },
      { 'X-ScoreArc-Observed-At': '' },
    ]) {
      const baseURL = await serve((_req, res) => res.writeHead(200, { ...validHeaders, ...override }).end(JSON.stringify([match])));
      expect((await checkScope({ baseURL, ...scope })).ok).toBe(false);
    }
  });
  it.each([['unknown', true], ['unknown', false], ['ok', false]] as const)(
    'rejects fresh all-finished collections with poll=%s and observedAt present=%s',
    async (pollStatus, observed) => {
      const headers: Record<string, string> = { ...validHeaders, 'X-ScoreArc-Poll-Status': pollStatus };
      if (!observed) delete headers['X-ScoreArc-Observed-At'];
      const baseURL = await serve((_req, res) => res.writeHead(200, headers).end(JSON.stringify([
        { ...match, state: 'finished', statusName: 'STATUS_FINAL' },
      ])));
      expect((await checkScope({ baseURL, ...scope })).ok).toBe(false);
    },
  );
  it('keeps all-finished incidents open until a fresh collection has observed poll-ok evidence', async () => {
    let headers: Record<string, string> = { ...validHeaders, 'X-ScoreArc-Freshness': 'stale' };
    const baseURL = await serve((_req, res) => res.writeHead(200, headers).end(JSON.stringify([
      { ...match, state: 'finished', statusName: 'STATUS_FINAL' },
    ])));
    const file = await stateFile();
    const options = { baseURL, scopes: [scope], stateFile: file };
    const opening = await runWatchdog({ ...options, initialize: true });
    expect(opening.exitCode).toBe(1);
    expect(opening.messages[0]).toContain('OPEN');
    for (const [pollStatus, observed] of [['unknown', false], ['unknown', true], ['ok', false]] as const) {
      headers = { ...validHeaders, 'X-ScoreArc-Poll-Status': pollStatus };
      if (!observed) delete headers['X-ScoreArc-Observed-At'];
      expect(await runWatchdog(options)).toEqual({ exitCode: 1, messages: [] });
      const state = JSON.parse(await readFile(file, 'utf8')) as { incidents: Record<string, boolean> };
      expect(state.incidents['world-cup/2026']).toBe(true);
    }
    headers = { ...validHeaders };
    expect((await checkScope({ baseURL, ...scope })).ok).toBe(true);
    const resolution = await runWatchdog(options);
    expect(resolution.exitCode).toBe(0);
    expect(resolution.messages).toHaveLength(1);
    expect(resolution.messages[0]).toContain('RESOLVED');
  });
  it('accepts explicit empty and dormant, not missing-success empty', async () => {
    for (const status of ['empty', 'dormant']) {
      const headers: Record<string, string> = { ...validHeaders, 'X-ScoreArc-Freshness': status };
      if (status === 'dormant') {
        headers['X-ScoreArc-Poll-Status'] = 'unknown';
        delete headers['X-ScoreArc-Observed-At'];
      }
      const baseURL = await serve((_req, res) => res.writeHead(200, headers).end('[]'));
      expect((await checkScope({ baseURL, ...scope })).ok).toBe(true);
    }
  });
  it.each(['ok', 'partial', 'failed', 'unknown'])('suppresses expected dormant scope with retained %s poll', async pollStatus => {
    for (const body of [[], [{ ...match, state: 'finished', statusName: 'STATUS_FINAL' }]]) {
      const headers: Record<string, string> = {
        ...validHeaders, 'X-ScoreArc-Freshness': 'dormant', 'X-ScoreArc-Poll-Status': pollStatus,
      };
      delete headers['X-ScoreArc-Observed-At'];
      const baseURL = await serve((_req, res) => res.writeHead(200, headers).end(JSON.stringify(body)));
      expect((await checkScope({ baseURL, ...scope })).ok).toBe(true);
    }
  });
  it('resolves an active partial-poll incident once on dormancy without repeating off-season alarms', async () => {
    let dormant = false;
    const baseURL = await serve((_req, res) => res.writeHead(200, {
      ...validHeaders, 'X-ScoreArc-Freshness': dormant ? 'dormant' : 'stale',
      'X-ScoreArc-Poll-Status': 'partial', 'X-ScoreArc-Stale-Matches': dormant ? '0' : '1',
    }).end(JSON.stringify(dormant ? [] : [match])));
    const options = { baseURL, scopes: [scope], stateFile: await stateFile() };
    const opened = await runWatchdog({ ...options, initialize: true });
    expect(opened.exitCode).toBe(1);
    expect(opened.messages[0]).toContain('OPEN');
    dormant = true;
    const resolved = await runWatchdog(options);
    expect(resolved.exitCode).toBe(0);
    expect(resolved.messages).toHaveLength(1);
    expect(resolved.messages[0]).toContain('RESOLVED');
    expect(resolved.messages[0]).toContain('freshness=dormant poll=partial');
    expect(await runWatchdog(options)).toEqual({ exitCode: 0, messages: [] });
  });
  it('bounds response bytes, including chunked bodies, and deadline including body reads', async () => {
    const huge = await serve((_req, res) => {
      res.writeHead(200, validHeaders);
      res.write('[');
      res.end(' '.repeat(2000)+']');
    });
    expect((await checkScope({ baseURL: huge, ...scope, maxBytes: 1000 })).ok).toBe(false);
    const stalled = await serve((_req, res) => {
      res.writeHead(200, validHeaders);
      res.write('[');
    });
    const started = Date.now();
    const result = await checkScope({ baseURL: stalled, ...scope, timeoutMs: 40 });
    expect(result.ok).toBe(false);
    expect(result.context).toContain('timeout');
    expect(Date.now()-started).toBeLessThan(2000);
  });
  it('does not follow redirects or wait indefinitely for response headers', async () => {
    const redirected = await serve((_req, res) => res.writeHead(302, { Location: 'https://example.com' }).end());
    expect((await checkScope({ baseURL: redirected, ...scope })).ok).toBe(false);
    const stalled = await serve(() => {});
    expect((await checkScope({ baseURL: stalled, ...scope, timeoutMs: 40 })).context).toContain('timeout');
  });
  it('deduplicates openings, resolves once and reopens recurrence across runs', async () => {
    let stale = true;
    const baseURL = await serve((_req, res) => res.writeHead(200, {
      ...validHeaders, 'X-ScoreArc-Freshness': stale ? 'stale' : 'fresh',
      'X-ScoreArc-Stale-Matches': stale ? '1' : '0',
    }).end(JSON.stringify([match])));
    const file = await stateFile();
    const options = { baseURL, scopes: [scope], stateFile: file };
    await expect(runWatchdog(options)).rejects.toThrow(/state/i);
    const opening = await runWatchdog({ ...options, initialize: true });
    expect(opening.exitCode).toBe(1);
    expect(opening.messages).toHaveLength(1);
    expect(opening.messages[0]).toMatch(/OPEN.*world-cup\/2026.*matches=1.*stale=1/);
    const duplicate = await runWatchdog(options);
    expect(duplicate.exitCode).toBe(1);
    expect(duplicate.messages).toEqual([]);
    stale = false;
    const resolution = await runWatchdog(options);
    expect(resolution.exitCode).toBe(0);
    expect(resolution.messages).toHaveLength(1);
    expect(resolution.messages[0]).toContain('RESOLVED');
    expect((await runWatchdog(options)).messages).toEqual([]);
    stale = true;
    expect((await runWatchdog(options)).messages[0]).toContain('OPEN');
    expect((await readFile(file, 'utf8')).length).toBeLessThan(1024);
  });
  it('fails closed on corrupt, oversized or wrong-scope state without reset', async () => {
    const file = await stateFile();
    for (const content of ['{', '{}', ' '.repeat(33000), JSON.stringify({ version: 1, origin: 'https://other.invalid', incidents: {} })]) {
      await writeFile(file, content);
      await expect(runWatchdog({ baseURL: 'https://example.com', scopes: [scope], stateFile: file, initialize: true })).rejects.toThrow(/state/i);
      expect(await readFile(file, 'utf8')).toBe(content);
    }
  });
  it('does not recursively delete unexpected contents in its lock directory', async () => {
    const file = await stateFile();
    const baseURL = await serve(async (_req, res) => {
      await writeFile(`${file}.lock/unexpected`, 'keep');
      res.writeHead(200, validHeaders).end(JSON.stringify([match]));
    });
    await expect(runWatchdog({ baseURL, scopes: [scope], stateFile: file, initialize: true })).rejects.toThrow();
    expect(await readFile(`${file}.lock/unexpected`, 'utf8')).toBe('keep');
  });
  it('uses only configured current seasons with finite validated scope', () => {
    expect(currentScopes([{ id: 'world-cup', currentSeasonId: '2026', seasons: { '2026': { id: '2026' }, '1998': { id: '1998' } } }])).toEqual([scope]);
    for (const config of [[], [{}], Array(33).fill({ id: 'x', currentSeasonId: 'x', seasons: { x: { id: 'x' } } })]) {
      expect(() => currentScopes(config)).toThrow();
    }
    expect(() => currentScopes([{ id: 123, currentSeasonId: '2026', seasons: { '2026': { id: '2026' } } }])).toThrow();
  });
  it('uses native CLI exit codes on every unresolved run even when output is deduplicated', async () => {
    let stale = true;
    const baseURL = await serve((_req, res) => res.writeHead(200, {
      ...validHeaders, 'X-ScoreArc-Freshness': stale ? 'stale' : 'fresh',
      'X-ScoreArc-Stale-Matches': stale ? '1' : '0',
    }).end(JSON.stringify([match])));
    const file = await stateFile();
    const run = (initialize = false) => new Promise<{ code: number; stdout: string }>(resolve => {
      execFile(process.execPath, [
        'scripts/match-freshness-watchdog.mjs', '--base-url', baseURL, '--state-file', file,
        ...(initialize ? ['--init-state'] : []),
      ], { env: { ...process.env, GITHUB_OUTPUT: '' } },
      (error, stdout) => resolve({ code: typeof error?.code === 'number' ? error.code : error ? -1 : 0, stdout }));
    });
    expect((await run()).code).toBe(2);
    expect((await run(true)).code).toBe(1);
    expect(await run()).toEqual({ code: 1, stdout: '' });
    stale = false;
    const recovered = await run();
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toContain('RESOLVED world-cup/2026');
  });
  it('keeps the workflow manual-only with verified immutable action pins and explicit bootstrap', async () => {
    const workflow = await readFile('.github/workflows/match-freshness.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s*(schedule|push|pull_request):/m);
    const document = await watchdogWorkflow();
    const inputs = document.on.workflow_dispatch.inputs;
    expect(inputs.initialize_state).toMatchObject({ type: 'boolean', default: false });
    expect(inputs.state_run_id.required).toBe(false);
    const steps = document.jobs.check.steps;
    expect(steps.find(step => step.uses?.startsWith('actions/checkout@'))?.uses).toBe('actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1');
    expect(steps.find(step => step.uses?.startsWith('actions/download-artifact@'))?.uses).toBe('actions/download-artifact@018cc2cf5baa6db3ef3c5f8a56943fffe632ef53');
    expect(steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))?.uses).toBe('actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f');
    expect(steps.find(step => step.id === 'restore')?.if).toContain('!inputs.initialize_state');
    expect(steps.find(step => step.id === 'restore')?.with?.['run-id']).toBe('${{ inputs.state_run_id }}');
    const check = steps.find(step => step.id === 'check');
    expect(check?.env?.INITIALIZE_STATE).toBe('${{ inputs.initialize_state }}');
    expect(check?.run).toContain('--init-state');
    const upload = steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe("always() && steps.check.outputs.state_written == 'true'");
    expect(upload?.with?.path).toBe('watchdog-state/state.json');
    expect(steps.findIndex(step => step.id === 'validate')).toBeLessThan(steps.findIndex(step => step.id === 'restore'));
  });
  it('executes workflow validation for exactly one explicit bootstrap or prior run', async () => {
    const document = await watchdogWorkflow();
    const validate = document.jobs.check.steps.find(step => step.id === 'validate');
    expect(validate?.env).toMatchObject({
      INITIALIZE_STATE: '${{ inputs.initialize_state }}', STATE_RUN_ID: '${{ inputs.state_run_id }}',
    });
    expect(validate?.run).toBeTypeOf('string');
    for (const [initialize, runId, succeeds] of [
      ['true', '', true], ['false', '123456', true],
      ['false', '', false], ['true', '123456', false],
      ['false', 'invalid', false], ['false', '0', false], ['false', '1; echo bad', false],
    ] as const) {
      const result = await shell(validate!.run!, { INITIALIZE_STATE: initialize, STATE_RUN_ID: runId });
      expect(result.code === 0, `${initialize}/${runId}`).toBe(succeeds);
    }
  });
  it('runs the workflow bootstrap and later restore check without resets, preserving failed-run state', async () => {
    const document = await watchdogWorkflow();
    const check = document.jobs.check.steps.find(step => step.id === 'check');
    expect(check?.run).toBeTypeOf('string');
    const cwd = await mkdtemp(join(tmpdir(), 'scorearc-watchdog-workflow-'));
    dirs.push(cwd);
    let stale = true;
    let unexpectedLockContent = false;
    const file = join(cwd, 'watchdog-state/state.json');
    const baseURL = await serve(async (_req, res) => {
      if (unexpectedLockContent) await writeFile(`${file}.lock/unexpected`, 'keep');
      res.writeHead(200, {
        ...validHeaders, 'X-ScoreArc-Freshness': stale ? 'stale' : 'fresh',
        'X-ScoreArc-Stale-Matches': stale ? '1' : '0',
      }).end(JSON.stringify([match]));
    });
    let runId = 0;
    const checkRun = async (initialize: boolean) => {
      const output = join(cwd, `output-${runId++}`);
      const result = await shell(check!.run!.replaceAll('https://scorearc-reader.fly.dev', baseURL), {
        INITIALIZE_STATE: String(initialize), GITHUB_WORKSPACE: process.cwd(), GITHUB_OUTPUT: output,
      }, cwd);
      let written = '';
      try { written = await readFile(output, 'utf8'); } catch { /* No state means no output. */ }
      return { ...result, written };
    };
    const missing = await checkRun(false);
    expect(missing.code).toBe(2);
    expect(missing.written).toBe('');
    const first = await checkRun(true);
    expect(first.code).toBe(1);
    expect(first.stdout).toContain('OPEN world-cup/2026');
    expect(first.written).toBe('state_written=true\n');
    const saved = JSON.parse(await readFile(file, 'utf8')) as { incidents: Record<string, boolean> };
    expect(saved.incidents['world-cup/2026']).toBe(true);
    const again = await checkRun(false);
    expect(again).toEqual({ code: 1, stdout: '', written: 'state_written=true\n' });
    stale = false;
    const recovered = await checkRun(false);
    expect(recovered.code).toBe(0);
    expect(recovered.stdout).toContain('RESOLVED world-cup/2026');
    expect(recovered.written).toBe('state_written=true\n');
    unexpectedLockContent = true;
    const cleanupFailed = await checkRun(false);
    expect(cleanupFailed.code).toBe(2);
    expect(cleanupFailed.written).toBe('state_written=true\n');
    expect(await readFile(`${file}.lock/unexpected`, 'utf8')).toBe('keep');
    await rm(`${file}.lock/unexpected`);
    await rmdir(`${file}.lock`);
    await writeFile(file, '{');
    const corrupt = await checkRun(false);
    expect(corrupt.code).toBe(2);
    expect(corrupt.written).toBe('');
    expect(await readFile(file, 'utf8')).toBe('{');
  });
});
