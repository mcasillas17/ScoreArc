import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const caller = 'mcasillas17/ScoreArc/.github/workflows/production-credentials.yml@refs/heads/main';
const env: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  GITHUB_REPOSITORY: 'mcasillas17/ScoreArc',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/main',
  GITHUB_WORKFLOW_REF: caller,
  GITHUB_SHA: 'a'.repeat(40),
  PREFLIGHT_SERVICE: 'reader',
  PREFLIGHT_ENVIRONMENT: 'production-reader',
  TOKEN_PRESENT: 'true',
  CONTROL_PRESENT: 'false',
  ORG_ID_PRESENT: 'false',
  PROJECT_ID_PRESENT: 'false',
};
const probe = (change: Partial<NodeJS.ProcessEnv> = {}) =>
  spawnSync(process.execPath, ['scripts/production-credentials.mjs'], {
    env: { ...env, ...change }, encoding: 'utf8',
  });

describe('non-deploying credential presence probe', () => {
  // Actual same-SHA hosted measurements, not proof of injection in a new topology.
  it.each([
    ['reader', '34100370795', false],
    ['ingester', '34100370559', false],
    ['frontend', '34576989906', true],
  ])('interprets %s run %s direct presence and reusable absence as measurements', (service, _runId, idsPresent) => {
    const measured = {
      PREFLIGHT_SERVICE: service, PREFLIGHT_ENVIRONMENT: `production-${service}`,
      GITHUB_SHA: '5a31554402c2f406e3c7d6b6e77d0e7dc9eb14cd',
      ORG_ID_PRESENT: String(idsPresent), PROJECT_ID_PRESENT: String(idsPresent),
    };
    const direct = probe({ ...measured, TOKEN_PRESENT: 'true' });
    const reusable = probe({ ...measured, TOKEN_PRESENT: 'false' });
    expect(direct.status).toBe(0);
    expect(JSON.parse(direct.stdout).token_present).toBe(true);
    expect(reusable.status).toBe(1);
    expect(JSON.parse(reusable.stdout)).toEqual({
      token_present: false, control_present: false,
      org_id_present: idsPresent, project_id_present: idsPresent,
    });
    expect(reusable.stderr).toContain('Required credentials absent; no deployment attempted');
  });
  it.each(['reader', 'ingester'])('checks only %s credentials, not frontend IDs', service => {
    const result = probe({ PREFLIGHT_SERVICE: service, PREFLIGHT_ENVIRONMENT: `production-${service}` });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      token_present: true, control_present: false, org_id_present: false, project_id_present: false,
    });
  });
  it('reports missing credentials as booleans and fails, never a successful release or intentional skip', () => {
    const result = probe({ TOKEN_PRESENT: 'false', CONTROL_PRESENT: 'true' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ token_present: false, control_present: true });
    expect(result.stderr).toContain('Required credentials absent; no deployment attempted');
  });
  it('does not treat an absent optional control as proof of empty stored tokens', () => {
    const result = probe({ TOKEN_PRESENT: 'false' });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ token_present: false, control_present: false });
    expect(result.stderr).not.toMatch(/stored token is empty|inherit/);
  });
  it('requires frontend token and both project identifiers', () => {
    const frontend = {
      PREFLIGHT_SERVICE: 'frontend', PREFLIGHT_ENVIRONMENT: 'production-frontend',
      ORG_ID_PRESENT: 'true', PROJECT_ID_PRESENT: 'true',
    };
    expect(probe(frontend).status).toBe(0);
    for (const key of ['TOKEN_PRESENT', 'ORG_ID_PRESENT', 'PROJECT_ID_PRESENT']) {
      const result = probe({ ...frontend, [key]: 'false' });
      expect(result.status).toBe(1);
      expect(Object.values(JSON.parse(result.stdout)).every(value => typeof value === 'boolean')).toBe(true);
    }
  });
  it.each([
    { GITHUB_REPOSITORY: 'attacker/ScoreArc' },
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'pull_request_target' },
    { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_EVENT_NAME: 'workflow_run' },
    { GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_REF: 'refs/tags/main' },
    { GITHUB_WORKFLOW_REF: caller.replace('production-credentials.yml', 'ci.yml') },
    { GITHUB_WORKFLOW_REF: caller.replace('@refs/heads/main', '@refs/heads/feature') },
    { GITHUB_SHA: 'main' },
    { PREFLIGHT_SERVICE: 'unknown' },
    { PREFLIGHT_ENVIRONMENT: 'production-ingester' },
  ])('rejects unauthorized context before printing presence: %j', change => {
    const result = probe(change);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Protected main credential preflight required|Expected a full lowercase commit SHA/);
  });
  it.each(['', 'TRUE', '1', 'raw-credential-DO-NOT-PRINT\n::notice::unsafe'])('rejects non-boolean inputs without reflecting them: %j', value => {
    for (const key of ['TOKEN_PRESENT', 'CONTROL_PRESENT', 'ORG_ID_PRESENT', 'PROJECT_ID_PRESENT']) {
      const result = probe({ [key]: value });
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('Expected presence booleans only');
      if (value.startsWith('raw-credential')) expect(result.stderr).not.toContain(value);
    }
  });
  it('ignores raw credentials and never writes Actions outputs, summaries or release records', () => {
    const result = probe({
      FLY_API_TOKEN: 'SENSITIVE-FLY', VERCEL_TOKEN: 'SENSITIVE-VERCEL',
      GH_TOKEN: 'SENSITIVE-GITHUB', GITHUB_OUTPUT: '/nonexistent/output',
      GITHUB_STEP_SUMMARY: '/nonexistent/summary',
    });
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain('SENSITIVE');
    expect(Object.values(JSON.parse(result.stdout)).every(value => typeof value === 'boolean')).toBe(true);
    const script = readFileSync('scripts/production-credentials.mjs', 'utf8');
    expect(script).not.toMatch(/fetch\(|child_process|writeFile|appendFile|production-release/);
  });
});

describe('protected credential workflow wiring', () => {
  it('mirrors the ordinary production matrix environment binding without any provider operation', () => {
    const workflow = readFileSync('.github/workflows/production-credentials.yml', 'utf8');
    const production = readFileSync('.github/workflows/ci.yml', 'utf8').split('\n  production:\n')[1];
    expect(existsSync('.github/workflows/production-credential-probe.yml')).toBe(false);
    expect(workflow).toContain('  workflow_dispatch:');
    expect(workflow).toContain('options: [reader, ingester, frontend]');
    expect(workflow).not.toMatch(/^\s+(push|workflow_call|workflow_run|pull_request|pull_request_target):/m);
    expect(workflow.match(/^  \w+:$/gm)).toEqual(['  workflow_dispatch:', '  probe:']);
    expect(workflow).toContain('service: ["${{ inputs.service }}"]');
    expect(workflow).toContain('PREFLIGHT_SERVICE: ${{ matrix.service }}');
    expect(workflow).toContain('PREFLIGHT_ENVIRONMENT: production-${{ matrix.service }}');
    for (const shared of [
      'runs-on: ubuntu-latest', 'fail-fast: false', 'name: production-${{ matrix.service }}',
      'deployment: false', 'ref: ${{ github.sha }}', 'persist-credentials: false',
    ]) {
      expect(workflow).toContain(shared);
      expect(production).toContain(shared);
    }
    expect(workflow).toContain("github.repository == 'mcasillas17/ScoreArc'");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
    expect(workflow).toContain(`github.workflow_ref == '${caller}'`);
    expect(workflow).toContain("contains(fromJSON('[\"reader\",\"ingester\",\"frontend\"]'), inputs.service)");
    expect(workflow).toContain('contents: read');
    expect(workflow).not.toMatch(/: write|secrets:|inherit|production-release\.mjs|flyctl|vercel@|continue-on-error|actions\/upload-artifact|uses: \.\/|GITHUB_OUTPUT/);
    const commands = [...workflow.matchAll(/^\s+run: (.+)$/gm)].map(match => match[1]);
    expect(commands).toEqual(['node scripts/production-credentials.mjs']);
    const secretLines = workflow.split('\n').filter(line => line.includes('secrets.'));
    expect(secretLines).toHaveLength(2);
    expect(secretLines.every(line => line.includes('_PRESENT:') && line.includes("!= ''"))).toBe(true);
    const flySelection = "matrix.service == 'reader' && secrets.FLY_API_TOKEN_READER || matrix.service == 'ingester' && secrets.FLY_API_TOKEN_INGESTER";
    const vercelSelection = "matrix.service == 'frontend' && secrets.VERCEL_TOKEN";
    for (const selection of [flySelection, vercelSelection]) {
      expect(production).toContain(selection);
      expect(workflow).toContain(selection);
    }
    for (const action of workflow.matchAll(/uses: ([\w/-]+)@([^\s]+)/g)) {
      expect(action[2]).toMatch(/^[a-f0-9]{40}$/);
    }
  });
});
