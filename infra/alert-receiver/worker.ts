// Receives match-monitor events (scripts/match-freshness-monitor.mjs) and emails the
// owner. Contract: docs/backend/MATCH_FRESHNESS.md#alert-receiver. HTTP 200 with
// {"eventId"} means saved and emailed; anything else makes the sender retry the same id.

interface Statement {
  first<T>(): Promise<T | null>;
  run(): Promise<unknown>;
}
export interface Env {
  DB: { prepare(sql: string): { bind(...values: (string | number)[]): Statement } };
  EMAIL: { send(message: { to: string; from: string; subject: string; text: string; html: string }): Promise<unknown> };
  RECEIVER_TOKEN: string;
  ALERT_RECIPIENT: string;
}

const ALERT_SENDER = 'alerts@scorearc.futbol';
const MAX_BODY_BYTES = 4096;
const MIN_TOKEN_LENGTH = 32;
// ponytail: one fixed cap on new work, a leaked token can still use it up. Rotate the
// token if the cap trips without a matching incident.
const MAX_EVENTS_PER_DAY = 300;

const eventId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]{0,15}$/;
const slug = /^[a-z0-9][a-z0-9-]{0,79}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const runUrl = /^https:\/\/github\.com\/mcasillas17\/ScoreArc\/actions\/runs\/[1-9][0-9]{0,19}$/;
const errorCategory = /^(http-\d{3}|content-type|response-size|body|json|body-contract|counts-contract|headers-contract|request|timeout)$/;
const KEYS = 'competition count error eventId freshness incidentId occurredAt overdue poll runUrl season stale status';

type Event = Record<'eventId' | 'incidentId' | 'competition' | 'season' | 'status' | 'occurredAt' | 'runUrl', string> &
  Record<'count' | 'stale' | 'overdue', number | null> & { freshness: string | null; poll: string | null; error: string | null };

const matches = (pattern: RegExp, value: unknown) => typeof value === 'string' && pattern.test(value);
const countOrNull = (value: unknown) => value === null || (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 5000);
const oneOfOrNull = (value: unknown, allowed: string[]) => value === null || (typeof value === 'string' && allowed.includes(value));

// Everything that reaches the email is matched here, so it cannot carry headers or markup.
function isEvent(value: unknown): value is Event {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return Object.keys(e).sort().join(' ') === KEYS && matches(eventId, e.eventId) && matches(eventId, e.incidentId) &&
    matches(slug, e.competition) && matches(slug, e.season) && (e.status === 'OPEN' || e.status === 'RESOLVED') &&
    matches(instant, e.occurredAt) && matches(runUrl, e.runUrl) && countOrNull(e.count) && countOrNull(e.stale) && countOrNull(e.overdue) &&
    oneOfOrNull(e.freshness, ['fresh', 'empty', 'dormant', 'stale', 'unavailable']) && oneOfOrNull(e.poll, ['ok', 'partial', 'failed', 'unknown']) &&
    (e.error === null || matches(errorCategory, e.error));
}

async function sameToken(a: string, b: string) {
  const [left, right] = await Promise.all([a, b].map(async text => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))));
  return left.reduce((difference, byte, index) => difference | (byte ^ right[index]), 0) === 0;
}

// Returns null above the limit, including a body that lies about or omits its length.
async function boundedText(request: Request) {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return null;
  if (!request.body) return '';
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) return null;
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
  return { to: env.ALERT_RECIPIENT, from: ALERT_SENDER, subject: `[ScoreArc] ${event.status}: ${event.competition} ${event.season}`, text, html: `<pre>${text}</pre>` };
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

async function handle(request: Request, env: Env) {
  if (!env.RECEIVER_TOKEN || env.RECEIVER_TOKEN.length < MIN_TOKEN_LENGTH || !env.ALERT_RECIPIENT) {
    console.error('alert-receiver: configuration incomplete');
    return empty(500);
  }
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/events/') || !(await sameToken(path.slice('/events/'.length), env.RECEIVER_TOKEN))) return empty(404);
  if (request.method !== 'POST') return rejected(405);
  if (!/^application\/json(\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return rejected(415);
  const raw = await boundedText(request);
  if (raw === null) return rejected(413);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return rejected(400); }
  if (!isEvent(parsed) || request.headers.get('idempotency-key') !== parsed.eventId) return rejected(400);

  // Field order is fixed so that an identical event always compares equal on retry.
  const event = parsed;
  const payload = JSON.stringify(KEYS.split(' ').map(key => event[key as keyof Event]));
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
    try {
      await env.EMAIL.send(message(event, env));
    } catch (error) {
      logFailure('email', error);
      return empty(503);
    }
    await env.DB.prepare('UPDATE alert_event SET emailed_at = ? WHERE event_id = ?').bind(new Date().toISOString(), event.eventId).run();
  }
  return new Response(JSON.stringify({ eventId: event.eventId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: { waitUntil(work: Promise<unknown>): void }) {
    // The sender gives up after 5 seconds. Without waitUntil that disconnect could cancel
    // the work between the email and its record, so every retry would email again.
    const work = handle(request, env).catch(error => {
      logFailure('request', error);
      return empty(503);
    });
    ctx.waitUntil(work);
    return work;
  },
};
export default worker;
