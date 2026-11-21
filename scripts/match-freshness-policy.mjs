import { isISOInstant } from '../src/lib/matchFreshness.ts';

const kinds = ['full', 'rolling'];
const causes = [...kinds, 'matches'];
const twoHours = 2 * 60 * 60_000;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const only = (v, keys) => object(v) && Object.keys(v).every(k => keys.includes(k));

export function parsePollEvidence(header, now = Date.now()) {
  if (header === null) return {}; // Reader before migration 0029.
  let value;
  if (header.length <= 1024) {
    try { value = JSON.parse(header); } catch { throw new Error('headers-contract'); }
  }
  if (!only(value, kinds) || !Object.entries(value).every(([kind, p]) => only(p, ['at', 'outcome', 'missing']) &&
    isISOInstant(p.at) && Date.parse(p.at) <= now && ['ok','partial','failed'].includes(p.outcome) &&
    Number.isSafeInteger(p.missing) && p.missing >= 0 && p.missing <= 5000 && (kind === 'full' || p.missing === 0))) {
    throw new Error('headers-contract');
  }
  return value;
}

export const newSignal = () => ({ waiting: {}, legacyFull: false, prior: null, bursts: {}, dormant: false, quietUntil: 0 });

export function validSignal(s, now) {
  return only(s, ['waiting','legacyFull','prior','bursts','dormant','quietUntil']) && typeof s.dormant === 'boolean' && (s.prior === null || causes.includes(s.prior)) &&
    Number.isSafeInteger(s.quietUntil) && s.quietUntil >= 0 && s.quietUntil <= now + twoHours &&
    only(s.waiting, kinds) && Object.values(s.waiting).every(at => isISOInstant(at) && Date.parse(at) <= now) &&
    typeof s.legacyFull === 'boolean' && (!s.legacyFull || Object.hasOwn(s.waiting, 'full')) &&
    only(s.bursts, causes) && Object.values(s.bursts).every(times => Array.isArray(times) && times.length <= 3 &&
      times.every((at, i) => Number.isSafeInteger(at) && at >= 0 && at <= now && (i === 0 || at >= times[i-1])));
}

// The receiver's event format stays unchanged: a partial/failed poll can make
// the edition stale without making any individual match overdue.
export function assessAlert(signal, result, open, now) {
  const { observation, pollEvidence = {} } = result;
  const dormant = observation.freshness === 'dormant' && result.ok;
  if (!observation.error) signal.dormant = dormant;
  // #300 readers report the full outcome without a timestamp. A missing header
  // cannot clear it, and a legacy OK cannot override a timestamped failure.
  if (!pollEvidence.full && result.fullStatus) {
    if (result.fullStatus !== 'ok' && !dormant && (!signal.waiting.full || signal.legacyFull)) {
      signal.waiting.full = new Date(now).toISOString();
      signal.legacyFull = true;
    } else if (result.fullStatus === 'ok' && signal.legacyFull) {
      delete signal.waiting.full;
      signal.legacyFull = false;
    }
  }
  for (const kind of kinds) {
    const p = pollEvidence[kind];
    if (!p) continue; // Missing or older evidence cannot resolve a known failure.
    const previous = signal.waiting[kind];
    if (previous && Date.parse(p.at) < Date.parse(previous)) continue;
    if (p.outcome !== 'ok' || p.missing > 0) {
      if (previous || !dormant) {
        signal.waiting[kind] = p.at;
        if (kind === 'full') signal.legacyFull = false;
      }
    } else if (previous && Date.parse(p.at) > Date.parse(previous)) {
      delete signal.waiting[kind];
      if (kind === 'full') signal.legacyFull = false;
    }
  }
  const blocked = kinds.find(k => signal.waiting[k]);
  const cause = blocked ?? (result.ok ? null : 'matches');
  const evidence = blocked && pollEvidence[blocked];
  const scopedPoll = (evidence && Date.parse(evidence.at) >= Date.parse(signal.waiting[blocked]))
    ? (evidence.outcome === 'ok' ? 'partial' : evidence.outcome)
    : (blocked === 'full' && result.fullStatus && result.fullStatus !== 'ok' ? result.fullStatus : 'unknown');
  for (const key of Object.keys(signal.bursts)) {
    signal.bursts[key] = signal.bursts[key].filter(at => now - at <= twoHours);
    if (!signal.bursts[key].length) delete signal.bursts[key];
  }
  const consecutive = cause !== null && signal.prior !== null;
  if (cause && !consecutive) signal.bursts[cause] = [...(signal.bursts[cause] ?? []), now].slice(-3);
  if (cause && !dormant && (signal.quietUntil || signal.bursts[cause]?.length >= 3)) {
    signal.quietUntil = now + twoHours;
  } else if (!cause && now >= signal.quietUntil) {
    signal.quietUntil = 0;
  }
  signal.prior = cause;
  return {
    cause,
    alert: cause ? (open || (!dormant && (consecutive || result.urgent !== false || signal.quietUntil > now))) : open && signal.quietUntil > now,
    observation: blocked && !observation.error ? { ...observation, freshness: result.ok ? 'stale' : observation.freshness, poll: scopedPoll } : observation,
  };
}
