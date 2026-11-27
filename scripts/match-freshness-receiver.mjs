import { boundedJSON } from './match-freshness-reader.mjs';
import { MAX_STATE, validateGitHubConfig } from './match-freshness-checkpoint.mjs';

// The receiver acknowledges only after its email goes out (4.5-5.1 s in production).
// MAX_SENDS sends + 1 heartbeat at this limit stay well inside the 10-minute job timeout.
export const SEND_TIMEOUT_MS = 15000;

export function webhook(value) {
  const url = new URL(value);
  const local = url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.hash) throw new Error('Invalid webhook configuration');
  return url;
}
export function receiverRequest(webhookURL, path, webhookToken = '') {
  const url = webhook(webhookURL);
  if (url.search) throw new Error('Invalid webhook configuration');
  if (typeof webhookToken === 'string' && webhookToken.length > 0) {
    if (/\s/.test(webhookToken) || url.pathname !== '/events') throw new Error('Invalid webhook configuration');
    url.pathname = path.replace(/\/$/, '');
    return { url, authHeader: { Authorization: `Bearer ${webhookToken}` } };
  }
  if (!/^\/events\/[^/]+$/.test(url.pathname)) throw new Error('Invalid webhook configuration');
  url.pathname = url.pathname.replace('/events/', path);
  return { url, authHeader: {} };
}
// T17.4: tells the receiver a monitor run finished its checks and delivery. The
// receiver emails the owner when these stop, so it lives at the same secret token.
export async function sendHeartbeat({ webhookURL, webhookToken = '', fetchImpl = fetch }) {
  const { url, authHeader } = receiverRequest(webhookURL, '/heartbeat/', webhookToken);
  const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(SEND_TIMEOUT_MS), headers: authHeader });
  if (response.status !== 204) throw new Error('not-acknowledged');
}

// A rollback reads the single checkpoint frozen by the drained receiver. No
// GitHub history selection or reader observations can substitute for that state.
export async function downloadFlyCheckpoint(env, options, fetchImpl = fetch) {
  validateGitHubConfig(options);
  if (env.RESTORE_FROM_FLY !== 'true' || env.MATCH_FRESHNESS_DELIVERY_ENABLED !== 'true' ||
      env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
      env.GITHUB_WORKFLOW_REF !== 'mcasillas17/ScoreArc/.github/workflows/match-freshness.yml@refs/heads/main' ||
      env.INITIALIZE_STATE !== 'false' || env.RECOVERY_RUN_ID || env.RECOVERY_ARTIFACT_ID) {
    throw new Error('Invalid Fly rollback invocation');
  }
  const { url, authHeader } = receiverRequest(env.MATCH_FRESHNESS_WEBHOOK_URL, '/checkpoint/', env.MATCH_FRESHNESS_WEBHOOK_TOKEN);
  if (url.protocol !== 'https:') throw new Error('Fly rollback requires an HTTPS receiver');
  const response = await fetchImpl(url, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    headers: { Accept: 'application/json', 'Cache-Control': 'no-store', ...authHeader },
  });
  if (response.status !== 200 || response.redirected) throw new Error('Drained checkpoint unavailable');
  return boundedJSON(response, MAX_STATE);
}
