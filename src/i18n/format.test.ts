import { describe, expect, it } from 'vitest';
import {
  formatDate,
  formatDateRange,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  formatTime,
} from './format';

describe('locale formatters', () => {
  const value = '2026-08-21T18:30:00Z';

  it('formats from an explicit locale and timezone', () => {
    expect(formatDate(value, 'en', { month: 'long', day: 'numeric', timeZone: 'UTC' })).toBe('August 21');
    expect(formatDate(value, 'es', { month: 'long', day: 'numeric', timeZone: 'UTC' })).toBe('21 de agosto');
  });

  it('returns null for missing or invalid dates', () => {
    expect(formatDate(null, 'es')).toBeNull();
    expect(formatDate('not-a-date', 'en')).toBeNull();
    expect(formatTime(undefined, 'es')).toBeNull();
    expect(formatDateTime('not-a-date', 'en')).toBeNull();
    expect(formatDateRange('not-a-date', value, 'en')).toBeNull();
    expect(formatDateRange(value, undefined, 'es')).toBeNull();
    expect(formatRelativeTime(new Date('not-a-date'), new Date(value), 'es')).toBeNull();
    expect(formatRelativeTime(new Date(value), new Date('not-a-date'), 'en')).toBeNull();
  });

  it('formats date ranges from an explicit locale and timezone', () => {
    expect(formatDateRange('2026-08-25', '2026-08-27', 'en')).toBe('August 25–27, 2026');
    expect(formatDateRange('2026-08-25', '2026-08-27', 'es')).toBe('25–27 de agosto de 2026');
  });

  it('accepts a real leap day in a configured ISO date range', () => {
    expect(formatDateRange('2024-02-29', '2024-03-01', 'en'))
      .toBe('February 29–March 1, 2024');
  });

  it('rejects configured dates outside the exact YYYY-MM-DD grammar', () => {
    expect(formatDateRange('2026-8-25', '2026-08-27', 'en')).toBeNull();
  });

  it('rejects impossible configured calendar dates', () => {
    expect(formatDateRange('2026-02-30', '2026-03-03', 'en')).toBeNull();
    expect(formatDateRange('2025-02-29', '2025-03-01', 'en')).toBeNull();
  });

  it('rejects trailing junk in configured dates', () => {
    expect(formatDateRange('2026-08-25junk', '2026-08-27', 'en')).toBeNull();
  });

  it('rejects reversed configured date ranges', () => {
    expect(formatDateRange('2026-08-27', '2026-08-25', 'en')).toBeNull();
  });

  it('formats numbers and relative time by locale', () => {
    expect(formatNumber(12345, 'en')).toBe('12,345');
    expect(formatNumber(12345, 'es')).toMatch(/^12[,.]345$/);
    expect(formatRelativeTime(new Date('2026-08-21T18:29:00Z'), new Date(value), 'es')).toBe('hace 1 min');
  });

  it('promotes rounded relative-time boundaries in both locales', () => {
    const now = new Date(value);

    expect(formatRelativeTime(new Date(now.getTime() + 59.5 * 60_000), now, 'en')).toBe('in 1 hr.');
    expect(formatRelativeTime(new Date(now.getTime() - 59.5 * 60_000), now, 'es')).toBe('hace 1 h');
    expect(formatRelativeTime(new Date(now.getTime() + 23.5 * 3_600_000), now, 'en')).toBe('in 1 day');
    expect(formatRelativeTime(new Date(now.getTime() - 23.5 * 3_600_000), now, 'es')).toBe('hace 1 día');
  });
});
