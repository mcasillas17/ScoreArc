import type { CompetitionSeason } from './competitions';
import { parseRange, seasonMonthBounds } from './dateRange';
import { scoreboardUrl } from './endpoints';

interface FetchOptions { signal: AbortSignal; maxBytes: number }
export type ScoreboardFetchJson = (url: string, options?: FetchOptions) => Promise<unknown>;
const DAY = 86_400_000;
const RESPONSE_BYTES = 4 * 1024 * 1024;
const WINDOW_BYTES = 16 * 1024 * 1024;
// Keep actual wire-body sizes for the aggregate budget; injected transports use
// the encoded JSON size. Weak keys do not retain responses beyond their caller.
const responseBytes = new WeakMap<object, number>();

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Existing generic fetch behavior stays unchanged unless a bounded read is requested. */
export async function boundedFetchJson(url: string, options?: FetchOptions): Promise<unknown> {
  options?.signal.throwIfAborted();
  const request = fetch(url, {
    headers: { 'User-Agent': 'scorearc' }, cache: 'no-store', signal: options?.signal,
  });
  const response = options ? await abortable(request, options.signal) : await request;
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error(`fetch ${url} -> ${response.status}`);
  }
  if (!options) return response.json();
  const { signal, maxBytes } = options;
  if (Number(response.headers.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Scoreboard response exceeds bytes budget');
  }
  if (!response.body) throw new Error('Scoreboard response body missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let complete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await abortable(reader.read(), signal);
      signal.throwIfAborted();
      if (part.done) { complete = true; break; }
      bytes += part.value.byteLength;
      if (bytes > maxBytes) throw new Error('Scoreboard response exceeds bytes budget');
      chunks.push(part.value);
    }
    const raw: unknown = JSON.parse(chunks.map((chunk, index) => decoder.decode(chunk, { stream: index < chunks.length - 1 })).join(''));
    if (raw !== null && typeof raw === 'object') responseBytes.set(raw, bytes);
    return raw;
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type Raw = Record<string, unknown>;
// JSON objects ignore key order, while array order and every value remain significant.
const canonicalJSON = (value: unknown) => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
function object(value: unknown): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed scoreboard object');
  return value as Raw;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function timestamp(value: unknown): number {
  if (typeof value !== 'string') throw new Error('Malformed scoreboard timestamp');
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const at = Date.parse(value);
  if (!parts || !Number.isFinite(at)) throw new Error('Malformed scoreboard timestamp');
  const day = new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])));
  if (day.getUTCFullYear() !== Number(parts[1]) || day.getUTCMonth() + 1 !== Number(parts[2]) ||
      day.getUTCDate() !== Number(parts[3]) || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6] ?? 0) > 59) {
    throw new Error('Malformed scoreboard timestamp');
  }
  return at;
}
function validateEvent(value: unknown): { event: Raw; id: string; at: number; season: Raw } {
  const event = object(value);
  if (!text(event.id)) throw new Error('Malformed scoreboard identity');
  const at = timestamp(event.date);
  const season = object(event.season);
  if (!Number.isInteger(season.year) || !text(season.slug)) throw new Error('Malformed scoreboard season');
  const statusEnvelope = object(event.status);
  const status = object(statusEnvelope.type);
  if (!['pre', 'in', 'post'].includes(String(status.state)) || typeof status.completed !== 'boolean' ||
      typeof status.shortDetail !== 'string' || (status.name != null && typeof status.name !== 'string') ||
      (statusEnvelope.displayClock != null && typeof statusEnvelope.displayClock !== 'string')) {
    throw new Error('Malformed scoreboard status');
  }
  if (!Array.isArray(event.competitions) || event.competitions.length !== 1) throw new Error('Malformed scoreboard competition');
  const competition = object(event.competitions[0]);
  if (competition.notes != null && (!Array.isArray(competition.notes) || competition.notes.some(note => {
    const value = object(note).text;
    return value != null && typeof value !== 'string';
  }))) throw new Error('Malformed scoreboard notes');
  if (!Array.isArray(competition.competitors) || competition.competitors.length !== 2) throw new Error('Malformed scoreboard teams');
  const sides = new Set<string>();
  const ids = new Set<string>();
  for (const value of competition.competitors) {
    const competitor = object(value);
    const team = object(competitor.team);
    if (!['home', 'away'].includes(String(competitor.homeAway)) || !text(team.id) || !text(team.displayName) || !text(team.abbreviation)) {
      throw new Error('Malformed scoreboard team');
    }
    sides.add(String(competitor.homeAway)); ids.add(team.id);
    for (const key of ['score', 'shootoutScore']) {
      const score = competitor[key];
      if (score != null && score !== '' &&
          !((typeof score === 'string' && /^\d+$/.test(score)) || (typeof score === 'number' && Number.isInteger(score) && score >= 0))) {
        throw new Error('Malformed scoreboard score');
      }
    }
    if (competitor.winner != null && typeof competitor.winner !== 'boolean') throw new Error('Malformed scoreboard winner');
  }
  if (sides.size !== 2 || ids.size !== 2) throw new Error('Malformed scoreboard teams');
  return { event, id: event.id, at, season };
}
const utcDate = (compact: string) => Date.UTC(Number(compact.slice(0, 4)), Number(compact.slice(4, 6)) - 1, Number(compact.slice(6, 8)));

/** Monthly provider partitions, one-day calendar guards, then exact UTC/season scope. */
export async function fetchScoreboardWindow(
  rc: CompetitionSeason, range: string, fetchJson: ScoreboardFetchJson, signal?: AbortSignal,
): Promise<{ events: Raw[] }> {
  signal?.throwIfAborted();
  if (!parseRange(range)) throw new Error('Invalid scoreboard range');
  const bounds = seasonMonthBounds(rc.season.id);
  const seasonStart = Date.parse(`${bounds.minMonth}T00:00:00Z`);
  const lastMonth = new Date(`${bounds.maxMonth}T00:00:00Z`);
  const seasonEnd = Date.UTC(lastMonth.getUTCFullYear(), lastMonth.getUTCMonth() + 1, 1);
  const start = Math.max(utcDate(range.slice(0, 8)), seasonStart);
  const end = Math.min(utcDate(range.slice(9)) + DAY, seasonEnd);
  if (end <= start) return { events: [] };

  // Recorded mex.1 January includes February 1 01:10Z. One day on each
  // edge covers provider-local calendar boundaries without an undocumented tz.
  const first = new Date(start - DAY);
  const month = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1));
  const months: number[] = [];
  while (month.getTime() <= end) {
    if (months.length === 6) throw new Error('Scoreboard range exceeds month budget');
    months.push(month.getTime());
    month.setUTCMonth(month.getUTCMonth() + 1);
  }
  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Scoreboard deadline exceeded')), 15_000);
  const seen = new Map<string, Raw>();
  const retained = new Map<string, Raw>();
  const publicYear = Number(rc.season.id.slice(0, 4));
  const expectedYear = publicYear - (rc.season.id.endsWith('-clausura') ? 1 : 0);
  const split = /-(apertura|clausura)$/.exec(rc.season.id)?.[1];
  // Play-in and knockout phase names vary across editions; the split and
  // optional public-year suffix establish scope, not an enumeration of rounds.
  const splitScope = split ? new RegExp(`^(?:torneo-${split}(?:-${publicYear})?|${split}(?:-${publicYear})?---[a-z0-9]+(?:-[a-z0-9]+)*)$`) : null;
  let bytes = 0;
  try {
    for (const monthStart of months) {
      controller.signal.throwIfAborted();
      const date = new Date(monthStart);
      const selector = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      const raw = await abortable(fetchJson(`${scoreboardUrl(rc.competition.espnSlug, selector)}&limit=1000`, {
        signal: controller.signal, maxBytes: RESPONSE_BYTES,
      }), controller.signal);
      controller.signal.throwIfAborted();
      const envelope = object(raw);
      const size = responseBytes.get(envelope) ?? new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
      bytes += size;
      if (size > RESPONSE_BYTES || bytes > WINDOW_BYTES) throw new Error('Scoreboard window exceeds bytes budget');
      if (!Array.isArray(envelope.leagues) || envelope.leagues.length !== 1 || object(envelope.leagues[0]).slug !== rc.competition.espnSlug) {
        throw new Error('Scoreboard league mismatch');
      }
      if (!Array.isArray(envelope.events) || envelope.events.length >= 1000) throw new Error('Scoreboard events missing or truncated');
      for (const key of ['count', 'total', 'pageCount']) {
        if (key in envelope && envelope[key] !== (key === 'pageCount' ? 1 : envelope.events.length)) throw new Error('Scoreboard pagination is incomplete');
      }
      const monthEnd = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      for (const value of envelope.events) {
        const { event, id, at, season } = validateEvent(value);
        if (at < monthStart - DAY || at >= monthEnd + DAY) throw new Error('Scoreboard event outside requested month');
        const previous = seen.get(id);
        if (previous && canonicalJSON(previous) !== canonicalJSON(event)) throw new Error('Conflicting scoreboard duplicate');
        seen.set(id, event);
        if (at < start || at >= end) continue;
        if (season.year !== expectedYear || (splitScope && !splitScope.test(String(season.slug)))) {
          throw new Error('Scoreboard event season mismatch');
        }
        retained.set(id, event);
      }
    }
    controller.signal.throwIfAborted();
    return { events: [...retained.values()] };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
