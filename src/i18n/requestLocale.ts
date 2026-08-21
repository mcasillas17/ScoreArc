import { DEFAULT_LOCALE, isLocale, type Locale } from './config';

type Candidate = { range: string; quality: number; order: number };

const MAX_ACCEPT_LANGUAGE_LENGTH = 4096;
const MAX_ACCEPT_LANGUAGE_ENTRIES = 32;
const LANGUAGE_RANGE = /^[a-z]{2}(?:-[a-z0-9]{1,8})*$/;
const QUALITY_VALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

export function preferredLocale(cookieValue: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(cookieValue)) return cookieValue;
  if (typeof acceptLanguage !== 'string' || acceptLanguage.length === 0) return DEFAULT_LOCALE;

  const candidates: Candidate[] = [];
  const entries = acceptLanguage.slice(0, MAX_ACCEPT_LANGUAGE_LENGTH).split(',', MAX_ACCEPT_LANGUAGE_ENTRIES);
  for (let order = 0; order < entries.length; order += 1) {
    const entry = entries[order];
    const [rawRange, ...parameters] = entry.trim().toLowerCase().split(';');
    if (!rawRange || (rawRange !== '*' && !LANGUAGE_RANGE.test(rawRange))) continue;

    let quality = 1;
    let hasQuality = false;
    let malformed = false;
    for (const parameter of parameters) {
      const match = /^q\s*=\s*(.*)$/.exec(parameter.trim());
      if (!match) continue;
      if (hasQuality) {
        malformed = true;
        break;
      }
      const rawQuality = match[1].trim();
      const parsed = Number(rawQuality);
      if (!QUALITY_VALUE.test(rawQuality) || !Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
        malformed = true;
        break;
      }
      quality = parsed;
      hasQuality = true;
    }
    if (!malformed && quality > 0) candidates.push({ range: rawRange, quality, order });
  }

  candidates.sort((a, b) => b.quality - a.quality || a.order - b.order);
  for (const candidate of candidates) {
    if (candidate.range === '*') return DEFAULT_LOCALE;
    const base = candidate.range.split('-', 1)[0];
    if (isLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
