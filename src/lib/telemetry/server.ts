import { track } from '@vercel/analytics/server';

type APIEndpoint =
  | 'bracket'
  | 'match-summary'
  | 'matches'
  | 'news'
  | 'standings'
  | 'top-scorers'
  | 'upcoming';

export function trackAPIRequestFailure(
  endpoint: APIEndpoint,
  status: number,
  competition?: string,
  season?: string,
) {
  void track('API request failed', {
    endpoint,
    status,
    competition,
    season,
  }, { headers: {} });
}
