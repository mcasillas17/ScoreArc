import { isISOInstant } from '@/lib/matchFreshness';
import type { Season } from './competitions';

// ScoreArc window strings are inclusive YYYYMMDD-YYYYMMDD dates. Calendar
// controls choose local dates; the data layer interprets their endpoints in UTC
// and translates them to padded provider month selectors.

function fmt(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// ScoreArc date window (YYYYMMDD-YYYYMMDD) covering the Monday→Sunday
// calendar week that contains `now` (local time). Used so the matches feed
// returns the whole current week's fixtures, not just ESPN's default (today).
export function currentWeekRange(now: Date): string {
  const mondayOffset = (now.getDay() + 6) % 7; // getDay(): 0=Sun..6=Sat → days since Monday
  const mon = new Date(now);
  mon.setDate(now.getDate() - mondayOffset);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  return `${fmt(mon)}-${fmt(sun)}`;
}

// ScoreArc date window covering today through `days` ahead. Used by
// the fixture banner, which must see past the end of the current week: a
// season starting next Friday has fixtures, and a banner that says otherwise
// is wrong rather than merely empty.
export function forwardRange(now: Date, days = 28): string {
  const end = new Date(now);
  end.setDate(now.getDate() + days);
  return `${fmt(now)}-${fmt(end)}`;
}

/** The whole calendar month containing `d`. */
export function monthRange(d: Date): string {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  // Day 0 of the next month is the last day of this one, which is how this
  // gets February and the 30-day months right without a lookup table.
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return `${fmt(first)}-${fmt(last)}`;
}

/**
 * The scoreboard window the "now" surfaces read: recent results behind, the
 * next fortnight ahead.
 *
 * Wider than the current week on purpose. `currentWeekRange` is right on a
 * matchday and empty the rest of the time — five of nine competitions were in
 * exactly that state on 2026-08-15, between them holding 132 scheduled
 * fixtures and displaying none.
 */
export function nowWindowRange(now: Date, backDays = 7, forwardDays = 14): string {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - backDays);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + forwardDays);
  return `${fmt(from)}-${fmt(to)}`;
}

/**
 * The first of the month `delta` months from `d`.
 *
 * Clamped to the 1st deliberately: `new Date(2026, 0, 31)` stepped forward with
 * setMonth lands on March 3, so navigating forward from a 31st would skip
 * February entirely.
 */
export function shiftMonth(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1);
}

/**
 * Inclusive month bounds derived from ScoreArc's season-id conventions.
 */
type EditionDates = Pick<Season, 'id' | 'startsAt' | 'endsAt'>;

export function seasonMonthBounds(season: string | EditionDates): { minMonth: string; maxMonth: string } {
  if (typeof season !== 'string' && (season.startsAt || season.endsAt)) {
    const { start, end } = editionBounds(season);
    const month = (ms: number) => new Date(ms).toISOString().slice(0, 7) + '-01';
    return { minMonth: month(start), maxMonth: month(end - 1) };
  }
  return conventionalMonths(typeof season === 'string' ? season : season.id);
}

function conventionalMonths(seasonId: string) {
  const crossYear = /^(\d{4})-(\d{2})$/.exec(seasonId);
  if (crossYear) {
    const startYear = Number(crossYear[1]);
    const endYear = startYear + 1;
    if (Number(crossYear[2]) === endYear % 100) {
      return {
        minMonth: `${startYear}-07-01`,
        maxMonth: `${endYear}-06-01`,
      };
    }
  }

  const splitSeason = /^(\d{4})-(apertura|clausura)$/.exec(seasonId);
  if (splitSeason) {
    const year = splitSeason[1];
    return splitSeason[2] === 'apertura'
      ? { minMonth: `${year}-07-01`, maxMonth: `${year}-12-01` }
      : { minMonth: `${year}-01-01`, maxMonth: `${year}-06-01` };
  }

  const calendarYear = /^(\d{4})$/.exec(seasonId);
  if (calendarYear) {
    const year = calendarYear[1];
    return { minMonth: `${year}-01-01`, maxMonth: `${year}-12-01` };
  }

  throw new Error(`Unsupported season id: ${seasonId}`);
}

export function editionBounds(season: EditionDates): { start: number; end: number } {
  if (season.startsAt !== undefined || season.endsAt !== undefined) {
    const start = Date.parse(season.startsAt ?? '');
    const end = Date.parse(season.endsAt ?? '');
    if (!(start < end) || !isISOInstant(season.startsAt) || !isISOInstant(season.endsAt) ||
        !season.startsAt.endsWith('Z') || !season.endsAt.endsWith('Z')) throw new Error('Invalid edition bounds');
    return { start, end };
  }
  const bounds = conventionalMonths(season.id);
  const last = new Date(bounds.maxMonth + 'T00:00:00Z');
  return { start: Date.parse(bounds.minMonth + 'T00:00:00Z'), end: Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1) };
}

const RANGE_RE = /^(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})$/;

function parseMonthStart(value: string): Date {
  const [year, month] = value.split('-').map(Number);
  return new Date(year, month - 1, 1);
}

/**
 * Choose an initial month inside the season. Completed tournament editions use
 * their last active bracket month rather than an empty calendar-year endpoint.
 */
export function seasonInitialMonth(now: Date, season: string | EditionDates, activeRange?: string): Date {
  const { minMonth, maxMonth } = seasonMonthBounds(season);
  const min = parseMonthStart(minMonth);
  const max = parseMonthStart(maxMonth);
  const current = new Date(now.getFullYear(), now.getMonth(), 1);
  const currentTime = current.getTime();

  if (activeRange && parseRange(activeRange)) {
    const start = activeRange.slice(0, 8);
    const end = activeRange.slice(9);
    const activeStartMonth = new Date(
      Number(start.slice(0, 4)),
      Number(start.slice(4, 6)) - 1,
      1,
    );
    const activeMonth = new Date(Number(end.slice(0, 4)), Number(end.slice(4, 6)) - 1, 1);
    const activeStart = activeStartMonth < min ? min : activeStartMonth;
    const activeEnd = activeMonth > max ? max : activeMonth;
    // Inside the season, matches can already be underway in the group phase.
    if (current < min) return activeStart;
    if (current > activeEnd) return activeEnd;
    return current;
  }

  if (currentTime >= min.getTime() && currentTime <= max.getTime()) return current;
  return currentTime < min.getTime() ? min : max;
}

/**
 * Validate a client-supplied `dates` range before it is interpolated into a
 * third-party URL.
 *
 * Anchored regex first, then real-date parsing (so 20260231 is rejected rather
 * than silently rolling to March 3), then ordering, then a span cap. The cap
 * exists because an unbounded range is a cheap way to make ScoreArc fetch
 * something enormous on someone else's behalf.
 */
export function parseRange(raw: string | null, maxDays = 92): string | null {
  if (!raw) return null;
  const m = RANGE_RE.exec(raw);
  if (!m) return null;

  const toDate = (y: string, mo: string, d: string): Date | null => {
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const date = new Date(year, month - 1, day);
    // Round-trip check: JS rolls invalid dates over silently, so 2026-02-31
    // becomes March 3 and would otherwise pass.
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  };

  const start = toDate(m[1], m[2], m[3]);
  const end = toDate(m[4], m[5], m[6]);
  if (!start || !end) return null;
  if (end.getTime() < start.getTime()) return null;

  const spanDays = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  if (spanDays > maxDays) return null;

  return raw;
}
