// Receives match-monitor events (scripts/match-freshness-monitor.mjs) and emails the
// owner. Contract: docs/backend/MATCH_FRESHNESS.md#alert-receiver. HTTP 200 with
// {"eventId"} means saved and emailed; anything else makes the sender retry the same id.
// It also takes monitor-run heartbeats and, on a cron, emails when they stop
// (docs/backend/MATCH_FRESHNESS.md#not-running-check). D1 selects which producer
// owns the five-minute check while the receiver keeps the same email receipts.
import { FLY_RUN_URL } from '../../scripts/match-freshness-fly.mjs';
import { eventPayload, isEvent, type Event } from './event-payload';
import { claim, exportCheckpoint, getMonitorMode, githubOwner, heartbeatGuard, MAX_CHECKPOINT,
  release, reservedEvent, saveCheckpoint, validTick } from './fly-runtime';

interface Statement {
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
export interface Env {
  DB: { prepare(sql: string): { bind(...values: (string | number)[]): Statement } };
  EMAIL: { send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<unknown> };
  RECEIVER_TOKEN: string;
  REQUIRE_HEADER_AUTH?: string;
  ALERT_RECIPIENT: string;
  FLY_MONITOR_TOKEN?: string;
  // Fine-grained token for this repository only, Actions read and write.
  GITHUB_DISPATCH_TOKEN?: string;
}

const WORKER_RUN_URL = 'https://dash.cloudflare.com/4fcb63110aa75522b2636c923eeff468/workers/services/view/scorearc-alert-receiver/production/observability/logs';
const ALERT_SENDER = 'alerts@scorearc.futbol';
const MAX_BODY_BYTES = 4096;
const MIN_TOKEN_LENGTH = 32;
// ponytail: one fixed cap on new work, a leaked token can still use it up. Rotate the
// token if the cap trips without a matching incident.
const MAX_EVENTS_PER_DAY = 300;
// The cron dispatches a run every 5 minutes, but a run can queue behind a slow one
// (10-minute job limit) and GitHub can start it late, so allow an hour.
const HEARTBEAT_MAX_AGE_MS = 60 * 60_000;
const WORKFLOW_URL = 'https://github.com/mcasillas17/ScoreArc/actions/workflows/match-freshness.yml';
const DISPATCH_URL = 'https://api.github.com/repos/mcasillas17/ScoreArc/actions/workflows/match-freshness.yml/dispatches';
const DISPATCH_TIMEOUT_MS = 10_000;

const matches = (pattern: RegExp, value: unknown) => typeof value === 'string' && pattern.test(value);

async function sameToken(a: string, b: string) {
  const [left, right] = await Promise.all([a, b].map(async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))));
  return left.reduce((difference, byte, index) => difference | (byte ^ right[index]), 0) === 0;
}

// Returns null above the limit, including a body that lies about or omits its length.
async function boundedText(request: Request, limit = MAX_BODY_BYTES) {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return null;
  if (!request.body) return '';
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return new Blob(chunks).text();
}

function message(event: Event, env: Env) {
  const headline = event.status === 'OPEN' ? 'Match data is unhealthy' : 'Match data has recovered';
  const text = [
    `${headline}: ${event.competition} ${event.season}`, '',
    `Status: ${event.status}`, `Occurred: ${event.occurredAt}`,
    `Freshness: ${event.freshness ?? 'unknown'}`, `Poll: ${event.poll ?? 'unknown'}`,
    `Matches: ${event.count ?? 'unknown'}`, `Stale: ${event.stale ?? 'unknown'}`, `Overdue: ${event.overdue ?? 'unknown'}`,
    `Check error: ${event.error ?? 'none'}`, '', `Run: ${event.runUrl}`, `Event: ${event.eventId}`, `Incident: ${event.incidentId}`,
  ].join('\n');
  return mail(env, `[ScoreArc] ${event.status}: ${event.competition} ${event.season}`, text);
}
const mail = (env: Env, subject: string, text: string) => ({ to: env.ALERT_RECIPIENT, from: ALERT_SENDER, subject, text, html: `<pre>${text}</pre>` });

function monitorMessage(down: boolean, at: string, env: Env) {
  const state = down ? `The match monitor has not completed a monitor run since ${at}.`
    : `The match monitor completed a monitor run again at ${at}.`;
  const text = `${state}\n\nCloudflare receiver logs: ${WORKER_RUN_URL}\nFly monitor: ${FLY_RUN_URL}\nGitHub workflow: ${WORKFLOW_URL}`;
  return mail(env, `[ScoreArc] Monitor ${down ? 'not running' : 'recovered'}`, text);
}

// The email binding has no cancellation signal. On an ambiguous timeout the
// sender keeps the same event ID, just as for a lost provider acknowledgment.
async function sendMail(env: Env, content: ReturnType<typeof mail>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([env.EMAIL.send(content), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Email deadline')), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

// A heartbeat after a down alert is the recovery. Until that email is recorded the alert
// stays set, so the next heartbeat retries it: like events, at least once. At most one
// write a minute: a leaked token can spend at most 1,440 D1 writes a day here.
const githubGuard = { query: `SELECT 1 FROM monitor_runtime WHERE id=1 AND ${githubOwner}`, args: [] };
async function heartbeat(env: Env, guard: { query: string; args: (string | number)[] } = githubGuard, at = Date.now()) {
  const now = new Date(at);
  const row = await env.DB.prepare(`INSERT INTO monitor_heartbeat(id, last_at) SELECT 1, ? WHERE EXISTS (${guard.query}) ON CONFLICT(id) DO UPDATE SET last_at = excluded.last_at WHERE last_at < ? RETURNING alerted_at`)
    .bind(now.toISOString(), ...guard.args, new Date(now.getTime() - 60_000).toISOString()).first<{ alerted_at: string | null }>();
  if (!row && !await env.DB.prepare(guard.query).bind(...guard.args).first()) return rejected(409);
  if (row?.alerted_at) {
    try {
      await sendMail(env, monitorMessage(false, now.toISOString(), env));
    } catch (error) {
      logFailure('email', error);
      return empty(503);
    }
    await env.DB.prepare('UPDATE monitor_heartbeat SET alerted_at = NULL WHERE alerted_at = ?').bind(row.alerted_at).run();
  }
  return empty(204);
}

// An alert newer than the last heartbeat is the current outage. An older one was followed
// by a heartbeat, whatever became of its recovery email, so a stale row is a new outage.
// Recorded after the send, so a failed update repeats the alert next check: at least once.
// It records the detection time, unconditionally, so a heartbeat landing during the
// send gets its recovery from the next heartbeat, and a silence after it is a new outage.
// ponytail: a failed record followed by a heartbeat leaves one down email with no
// recovery; claiming first would close that but can lose the alert (see the runbook).
async function checkHeartbeat(env: Env) {
  if (!env.ALERT_RECIPIENT) return console.error('alert-receiver: configuration incomplete');
  const detected = new Date().toISOString();
  const row = await env.DB.prepare('SELECT last_at, alerted_at FROM monitor_heartbeat WHERE id = 1').bind().first<{ last_at: string; alerted_at: string | null }>();
  if (!row || Date.now() - Date.parse(row.last_at) <= HEARTBEAT_MAX_AGE_MS || (row.alerted_at && row.alerted_at > row.last_at)) return;
  await sendMail(env, monitorMessage(true, row.last_at, env));
  await env.DB.prepare('UPDATE monitor_heartbeat SET alerted_at = ? WHERE id = 1').bind(detected).run();
}

// Starts one run on main. The workflow's own gates (MATCH_FRESHNESS_ENABLED, main only,
// one run at a time) still decide what it does. A failed start only logs: the missing
// heartbeats are what the check above alerts on.
async function dispatchMonitor(env: Env) {
  if (!env.GITHUB_DISPATCH_TOKEN) return console.error('alert-receiver: dispatch token missing');
  const response = await fetch(DISPATCH_URL, {
    // workerd rejects redirect 'error'; a 3xx is not ok, so it is logged as rejected.
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'scorearc-alert-receiver', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ ref: 'main' }),
  });
  await response.body?.cancel();
  if (!response.ok) console.error('alert-receiver: dispatch rejected', response.status);
}

// Provider and database errors can quote configuration, so only a known code is logged.
function logFailure(stage: string, error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  console.error(`alert-receiver: ${stage} failed`, matches(/^E_[A-Z_]{1,64}$/, code) ? code : 'unknown');
}

const empty = (status: number) => new Response(null, { status });
// Past the token check, so this names only the status. The sender reports every non-200
// alike, and a repeated rejection blocks its queue, so the status must be visible here.
function rejected(status: number) {
  console.error('alert-receiver: rejected', status);
  return empty(status);
}

async function handleFly(request: Request, env: Env, url: URL) {
  const action = url.pathname.slice('/fly/'.length);
  const token = env.FLY_MONITOR_TOKEN;
  if (url.protocol !== 'https:' || url.search || !['claim','pending','event','final','heartbeat','release'].includes(action) ||
      !token || token.length < MIN_TOKEN_LENGTH || token === env.RECEIVER_TOKEN ||
      !await sameToken(request.headers.get('authorization') ?? '', `Bearer ${token}`)) return empty(404);
  if (request.method !== 'POST') return rejected(405);
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return rejected(415);
  const checkpoint = action === 'pending' || action === 'final';
  const raw = await boundedText(request, checkpoint ? MAX_CHECKPOINT + 256 : MAX_BODY_BYTES);
  if (raw === null) return rejected(413);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch { return rejected(400); }
  if (!body || !validTick(body.tick)) return rejected(400);
  if (action === 'claim') return Object.keys(body).length === 1 ? claim(env.DB, body.tick) : rejected(400);
  if (typeof body.leaseUntil !== 'number' || !Number.isSafeInteger(body.leaseUntil) || body.leaseUntil <= body.tick ||
      Object.keys(body).length !== (checkpoint || action === 'event' ? 3 : 2)) return rejected(400);
  const lease = { tick: body.tick, leaseUntil: body.leaseUntil };
  if (action === 'pending' || action === 'final') return saveCheckpoint(env.DB, lease, action, body.checkpoint);
  if (action === 'release') return release(env.DB, lease);
  // Use the observed slot for a Fly heartbeat. Replaying the same final never
  // advances last_at, even if the lease hasn't been released yet.
  if (action === 'heartbeat') return heartbeat(env, heartbeatGuard(lease), lease.tick);
  const event = body.event;
  if (!isEvent(event, true)) return rejected(400);
  const canSend = () => reservedEvent(env.DB, lease, event);
  if (!await canSend()) return rejected(409);
  return acceptEvent(event, env, canSend);
}

async function handle(request: Request, env: Env) {
  if (!env.RECEIVER_TOKEN || env.RECEIVER_TOKEN.length < MIN_TOKEN_LENGTH || !env.ALERT_RECIPIENT) {
    console.error('alert-receiver: configuration incomplete');
    return empty(500);
  }
  const url = new URL(request.url);
  if (url.pathname.startsWith('/fly/')) return handleFly(request, env, url);
  if (url.search) return empty(404);
  const path = url.pathname;
  const cleanRoutes: Record<string, string> = {
    '/events': '/events/',
    '/heartbeat': '/heartbeat/',
    '/checkpoint': '/checkpoint/',
  };
  let route: string | undefined;
  if (Object.hasOwn(cleanRoutes, path)) {
    if (!await sameToken(request.headers.get('authorization') ?? '', `Bearer ${env.RECEIVER_TOKEN}`)) {
      return empty(404);
    }
    route = cleanRoutes[path];
  } else {
    if (env.REQUIRE_HEADER_AUTH === 'true') return empty(404);
    route = ['/events/', '/heartbeat/', '/checkpoint/'].find(prefix => path.startsWith(prefix));
    if (!route || !(await sameToken(path.slice(route.length), env.RECEIVER_TOKEN))) return empty(404);
  }
  if (request.method !== 'POST') return rejected(405);
  if (route === '/checkpoint/') return exportCheckpoint(env.DB);
  const legacy = await env.DB.prepare(githubGuard.query).bind().first();
  if (!legacy) return rejected(409);
  if (route === '/heartbeat/') return heartbeat(env);
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return rejected(415);
  const raw = await boundedText(request);
  if (raw === null) return rejected(413);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return rejected(400); }
  if (!isEvent(parsed) || request.headers.get('idempotency-key') !== parsed.eventId) return rejected(400);
  return acceptEvent(parsed, env, async () => Boolean(await env.DB.prepare(githubGuard.query).bind().first()));
}

async function acceptEvent(event: Event, env: Env, canSend?: () => Promise<boolean>) {
  // Field order is fixed so that an identical event always compares equal on retry.
  const payload = eventPayload(event);
  const select = () => env.DB.prepare('SELECT payload, emailed_at FROM alert_event WHERE event_id = ?').bind(event.eventId).first<{ payload: string; emailed_at: string | null }>();
  let stored = await select();
  if (!stored) {
    // One statement, so the cap holds under concurrency. It limits new events only:
    // an accepted event must still reach the inbox when its retry arrives.
    const now = new Date();
    const since = new Date(now.getTime() - 86_400_000).toISOString();
    await env.DB.prepare('INSERT OR IGNORE INTO alert_event(event_id, payload, accepted_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM alert_event WHERE accepted_at > ?) < ?')
      .bind(event.eventId, payload, now.toISOString(), since, MAX_EVENTS_PER_DAY).run();
    stored = await select();
    if (!stored) {
      console.error('alert-receiver: daily event cap reached');
      return empty(503);
    }
  }
  if (stored.payload !== payload) return rejected(409);
  if (stored.emailed_at === null) {
    if (canSend && !await canSend()) return rejected(409);
    try {
      await sendMail(env, message(event, env));
    } catch (error) {
      logFailure('email', error);
      return empty(503);
    }
    await env.DB.prepare('UPDATE alert_event SET emailed_at = ? WHERE event_id = ?').bind(new Date().toISOString(), event.eventId).run();
  }
  return new Response(JSON.stringify({ eventId: event.eventId }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: { waitUntil(work: Promise<unknown>): void }) {
    // The sender gives up after 15 seconds. Without waitUntil that disconnect could cancel
    // the work between the email and its record, so every retry would email again.
    const work = handle(request, env).catch(error => {
      logFailure('request', error);
      return empty(503);
    });
    ctx.waitUntil(work);
    return work;
  },
  // Cron trigger in wrangler.jsonc. A failure here is retried by the next run.
  async scheduled(_controller: { scheduledTime: number }, env: Env) {
    await Promise.all([
      getMonitorMode(env.DB).then(mode => {
        if (mode === 'github') return dispatchMonitor(env).catch(error => logFailure('dispatch', error));
      }).catch(error => {
        logFailure('monitor', error);
        throw new Error('Match monitor execution failed');
      }),
      checkHeartbeat(env).catch(error => logFailure('heartbeat check', error)),
    ]);
  },
};
export default worker;
