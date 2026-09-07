import { assertSha, repository, services } from './production-policy.mjs';

const env = process.env;
const service = env.PREFLIGHT_SERVICE;
if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/production-credentials.yml@refs/heads/main` ||
    !services.includes(service) || env.PREFLIGHT_ENVIRONMENT !== `production-${service}`) {
  throw new Error('Protected main credential preflight required');
}
assertSha(env.GITHUB_SHA ?? '');

// Step expressions pass this probe presence booleans instead of raw credentials.
// The environment-bound runner and pinned actions remain trusted with secrets.
function presence(name) {
  if (!['true', 'false'].includes(env[name])) throw new Error('Expected presence booleans only');
  return env[name] === 'true';
}

const report = {
  token_present: presence('TOKEN_PRESENT'),
  control_present: presence('CONTROL_PRESENT'),
  org_id_present: presence('ORG_ID_PRESENT'),
  project_id_present: presence('PROJECT_ID_PRESENT'),
};
console.log(JSON.stringify(report));
if (!report.token_present ||
    (service === 'frontend' && (!report.org_id_present || !report.project_id_present))) {
  // JSON plus this error is a measured absence, not a probe/guard failure
  // (which emits no JSON). An absent optional control cannot prove stored emptiness.
  console.error('Required credentials absent; no deployment attempted');
  process.exitCode = 1;
}
