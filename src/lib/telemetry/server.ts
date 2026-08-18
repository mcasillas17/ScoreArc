import { track } from '@vercel/analytics/server';

type APIEndpoint =
  | 'bracket'
  | 'fixtures'
  | 'match-summary'
  | 'matches'
  | 'news'
  | 'standings'
  | 'top-scorers'
  | 'upcoming';

const eventIntervalMs = 60_000;
const lastTrackedAt = new Map<string, number>();

export function trackAPIRequestFailure(
  endpoint: APIEndpoint,
  status: number,
  competition?: string,
  season?: string,
) {
  const key = `${endpoint}:${status}:${competition ?? ''}:${season ?? ''}`;
  const now = Date.now();
  if ((lastTrackedAt.get(key) ?? 0) + eventIntervalMs > now) return;
  lastTrackedAt.set(key, now);

  void track('API request failed', {
    endpoint,
    status,
    competition,
    season,
  }, { headers: {} });
}
