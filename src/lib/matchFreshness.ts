export type MatchFreshness = {
  status: 'fresh' | 'empty' | 'dormant' | 'stale' | 'unavailable';
  observedAt: string | null;
  pollStatus: 'ok' | 'partial' | 'failed' | 'unknown';
  staleMatches: number;
  overdueMatches: number;
};

// Date.parse alone accepts impossible calendar dates and date-only strings.
export function isISOInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || +parts[2] > 23 || +parts[3] > 59 || +parts[4] > 59 || !Number.isFinite(Date.parse(value))) return false;
  const day = new Date(`${parts[1]}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === parts[1];
}

/** Missing/invalid metadata is a contract error, never implicitly fresh. */
export function parseMatchFreshness(headers: Pick<Headers, 'get'>): MatchFreshness {
  const status = headers.get('X-ScoreArc-Freshness');
  const pollStatus = headers.get('X-ScoreArc-Poll-Status');
  const observedAt = headers.get('X-ScoreArc-Observed-At');
  if (status !== 'fresh' && status !== 'empty' && status !== 'dormant' && status !== 'stale' && status !== 'unavailable') {
    throw new Error('Invalid X-ScoreArc-Freshness');
  }
  if (pollStatus !== 'ok' && pollStatus !== 'partial' && pollStatus !== 'failed' && pollStatus !== 'unknown') {
    throw new Error('Invalid X-ScoreArc-Poll-Status');
  }
  if (observedAt !== null && !isISOInstant(observedAt)) throw new Error('Invalid X-ScoreArc-Observed-At');
  const count = (name: string): number => {
    const value = headers.get(name);
    if (value === null || !/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
      throw new Error(`Invalid ${name}`);
    }
    return Number(value);
  };
  const staleMatches = count('X-ScoreArc-Stale-Matches');
  const overdueMatches = count('X-ScoreArc-Overdue-Matches');
  if (overdueMatches > staleMatches || (['fresh', 'empty', 'dormant'].includes(status) && staleMatches !== 0)) {
    throw new Error('Contradictory match freshness counts');
  }
  if (status === 'empty' && (pollStatus !== 'ok' || observedAt === null)) {
    throw new Error('Empty requires successful poll evidence');
  }
  return { status, observedAt, pollStatus, staleMatches, overdueMatches };
}
