import { FLY_RUN_URL } from '../../scripts/match-freshness-fly.mjs';

const eventId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:[1-9][0-9]{0,15}$/;
const slug = /^[a-z0-9][a-z0-9-]{0,79}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const runUrl = /^https:\/\/github\.com\/mcasillas17\/ScoreArc\/actions\/runs\/[1-9][0-9]{0,19}$/;
const errorCategory = /^(http-\d{3}|content-type|response-size|body|json|body-contract|counts-contract|headers-contract|request|timeout)$/;
const KEYS = 'competition count error eventId freshness incidentId occurredAt overdue poll runUrl season stale status';

export type Event = Record<'eventId' | 'incidentId' | 'competition' | 'season' | 'status' | 'occurredAt' | 'runUrl', string> &
  Record<'count' | 'stale' | 'overdue', number | null> & { freshness: string | null; poll: string | null; error: string | null };

const matches = (pattern: RegExp, value: unknown) => typeof value === 'string' && pattern.test(value);
const countOrNull = (value: unknown) => value === null || (Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 5000);
const oneOfOrNull = (value: unknown, allowed: string[]) => value === null || (typeof value === 'string' && allowed.includes(value));

// Everything that reaches the email is matched here, so it cannot carry headers or markup.
export function isEvent(value: unknown, fly = false): value is Event {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return Object.keys(e).sort().join(' ') === KEYS && matches(eventId, e.eventId) && matches(eventId, e.incidentId) &&
    matches(slug, e.competition) && matches(slug, e.season) && (e.status === 'OPEN' || e.status === 'RESOLVED') &&
    matches(instant, e.occurredAt) && (matches(runUrl, e.runUrl) || (fly && e.runUrl === FLY_RUN_URL)) &&
    countOrNull(e.count) && countOrNull(e.stale) && countOrNull(e.overdue) &&
    oneOfOrNull(e.freshness, ['fresh', 'empty', 'dormant', 'stale', 'unavailable']) && oneOfOrNull(e.poll, ['ok', 'partial', 'failed', 'unknown']) &&
    (e.error === null || matches(errorCategory, e.error));
}

// D1 uses the same representation across GitHub deliveries, Fly deliveries
// and acknowledgment of Fly's pending reservations.
export function eventPayload(event: Record<string, unknown>) {
  return JSON.stringify(KEYS.split(' ').map(key => event[key]));
}
