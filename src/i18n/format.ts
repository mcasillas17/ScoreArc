import { intlLocale, type Locale } from './config';

type DateInput = string | Date | null | undefined;
type ConfiguredISODateInput = string | null | undefined;

function parseDateInput(value: DateInput): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseConfiguredISODate(value: ConfiguredISODateInput): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

export function formatDate(
  value: DateInput,
  locale: Locale,
  options: Intl.DateTimeFormatOptions = {},
): string | null {
  const date = parseDateInput(value);
  return date ? new Intl.DateTimeFormat(intlLocale(locale), options).format(date) : null;
}

export function formatDateRange(
  startValue: ConfiguredISODateInput,
  endValue: ConfiguredISODateInput,
  locale: Locale,
): string | null {
  const start = parseConfiguredISODate(startValue);
  const end = parseConfiguredISODate(endValue);
  if (!start || !end || start.getTime() > end.getTime()) return null;

  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).formatRange(start, end).replace(/\s*–\s*/, '–');
}

export function formatTime(value: DateInput, locale: Locale): string | null {
  return formatDate(value, locale, { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(value: DateInput, locale: Locale): string | null {
  return formatDate(value, locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(intlLocale(locale)).format(value);
}

export function formatRelativeTime(value: DateInput, now: DateInput, locale: Locale): string | null {
  const date = parseDateInput(value);
  const reference = parseDateInput(now);
  if (!date || !reference) return null;

  const seconds = Math.round((date.getTime() - reference.getTime()) / 1_000);
  const absolute = Math.abs(seconds);
  const direction = Math.sign(seconds);
  const roundedMinutes = Math.round(absolute / 60);
  const roundedHours = Math.round(absolute / 3_600);
  const [amount, unit]: [number, Intl.RelativeTimeFormatUnit] = absolute < 60
    ? [seconds, 'second']
    : roundedMinutes < 60
      ? [direction * roundedMinutes, 'minute']
      : roundedHours < 24
        ? [direction * roundedHours, 'hour']
        : [direction * Math.round(absolute / 86_400), 'day'];

  return new Intl.RelativeTimeFormat(intlLocale(locale), {
    numeric: absolute < 45 ? 'auto' : 'always',
    style: 'short',
  }).format(amount, unit);
}
