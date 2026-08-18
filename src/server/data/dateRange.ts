// ESPN scoreboard `dates` strings are YYYYMMDD-YYYYMMDD in local time. These
// helpers sit beside currentWeekRange and forwardRange in store.ts, which use
// the same format for the live week and the fixture banner respectively.

function fmt(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
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
 * The first of the month `delta` months from `d`.
 *
 * Clamped to the 1st deliberately: `new Date(2026, 0, 31)` stepped forward with
 * setMonth lands on March 3, so navigating forward from a 31st would skip
 * February entirely.
 */
export function shiftMonth(d: Date, delta: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + delta, 1);
}

const RANGE_RE = /^(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})$/;

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
