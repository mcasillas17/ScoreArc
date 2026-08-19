import { parseRange } from './dateRange';

export interface MatchQuery {
  // Explicit window, or null meaning "the current week".
  range: string | null;
  // Only 'scheduled' today: the forward feed, or a filter within a range.
  state: 'scheduled' | null;
  // Whether to enrich each match with its scorers and cards. That costs one
  // upstream request PER MATCH, which is why it is opt-in and window-capped.
  summary: boolean;
  limit: number | null;
}

// One upstream /summary request per match is affordable for a week of
// fixtures and not for a quarter of them. parseRange already caps a window at
// 92 days; this caps the enriched window far lower.
export const MAX_SUMMARY_DAYS = 14;

function daysInRange(range: string): number {
  const [from, to] = range.split('-');
  const at = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
  return Math.round((at(to) - at(from)) / 86_400_000) + 1;
}

/**
 * Validate the query for the matches endpoint.
 *
 * Every value here is attacker-controlled and `range` is interpolated into a
 * URL we call against a third-party API, so nothing is trusted and nothing
 * falls back silently: a present-but-invalid parameter is a client error, and
 * a silent fallback would hide a broken caller behind plausible-looking data.
 */
export function parseMatchQuery(params: URLSearchParams): { query: MatchQuery } | { error: string } {
  const rawRange = params.get('range');
  const range = rawRange === null ? null : parseRange(rawRange);
  if (rawRange !== null && range === null) {
    return { error: 'range must be YYYYMMDD-YYYYMMDD, ordered, and at most 92 days' };
  }

  const rawState = params.get('state');
  if (rawState !== null && rawState !== 'scheduled') {
    return { error: "state must be 'scheduled'" };
  }
  const state = rawState as 'scheduled' | null;

  const rawDetail = params.get('detail');
  if (rawDetail !== null && rawDetail !== 'summary') {
    return { error: "detail must be 'summary'" };
  }
  const summary = rawDetail === 'summary';
  if (summary && range !== null && daysInRange(range) > MAX_SUMMARY_DAYS) {
    return { error: `detail=summary costs one request per match and is limited to ${MAX_SUMMARY_DAYS} days` };
  }

  const rawLimit = params.get('limit');
  let limit: number | null = null;
  if (rawLimit !== null) {
    // Number('') is 0 and Number(' 5 ') is 5; neither is a limit a caller meant
    // to send, so the shape is checked before the value.
    if (!/^\d+$/.test(rawLimit)) return { error: 'limit must be a positive integer' };
    limit = Number(rawLimit);
    if (limit < 1 || limit > 100) return { error: 'limit must be between 1 and 100' };
  }

  return { query: { range, state, summary, limit } };
}
