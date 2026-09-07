import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
  it('compares direct and same-commit reusable contexts without broad secret inheritance', () => {
    const direct = readFileSync('.github/workflows/production-credentials.yml', 'utf8');
    const reusable = readFileSync('.github/workflows/production-credential-probe.yml', 'utf8');
    expect(direct).toContain('  workflow_dispatch:');
    expect(direct).toContain('options: [reader, ingester, frontend]');
    expect(direct).toContain('uses: ./.github/workflows/production-credential-probe.yml');
    expect(reusable).toContain('  workflow_call:');
    expect(reusable).not.toMatch(/^\s+(push|workflow_dispatch|workflow_run|pull_request):/m);
    for (const workflow of [direct, reusable]) {
      expect(workflow).toContain("github.repository == 'mcasillas17/ScoreArc'");
      expect(workflow).toContain("github.ref == 'refs/heads/main'");
      expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
      expect(workflow).toContain(`github.workflow_ref == '${caller}'`);
      expect(workflow).toContain("contains(fromJSON('[\"reader\",\"ingester\",\"frontend\"]'), inputs.service)");
      expect(workflow).toContain('name: production-${{ inputs.service }}');
      expect(workflow).toContain('deployment: false');
      expect(workflow).toContain('PREFLIGHT_ENVIRONMENT: production-${{ inputs.service }}');
      expect(workflow).toContain('ref: ${{ github.sha }}');
      expect(workflow).toContain('persist-credentials: false');
      expect(workflow).toContain('contents: read');
      expect(workflow).not.toMatch(/: write|secrets:|inherit|production-release\.mjs|flyctl|vercel@|continue-on-error|actions\/upload-artifact/);
      const commands = [...workflow.matchAll(/^\s+run: (.+)$/gm)].map(match => match[1]);
      expect(commands).toEqual(['node scripts/production-credentials.mjs']);
      const secretLines = workflow.split('\n').filter(line => line.includes('secrets.'));
      expect(secretLines).toHaveLength(2);
      expect(secretLines.every(line => line.includes('_PRESENT:') && line.includes("!= ''"))).toBe(true);
      expect(workflow).toContain("inputs.service == 'reader' && secrets.FLY_API_TOKEN_READER || inputs.service == 'ingester' && secrets.FLY_API_TOKEN_INGESTER || inputs.service == 'frontend' && secrets.VERCEL_TOKEN || ''");
    }
    const presenceBlock = (text: string) => text.split('\n').filter(line => /_PRESENT:/.test(line));
    expect(presenceBlock(direct)).toEqual(presenceBlock(reusable));
  });
});
