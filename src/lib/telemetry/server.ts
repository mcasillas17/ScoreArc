import { track } from '@vercel/analytics/server';

type APIEndpoint =
  | 'bracket'
  | 'match-summary'
  | 'matches'
  | 'news'
  | 'standings'
  | 'top-scorers'
  | 'upcoming';

export async function trackAPIRequestFailure(
  endpoint: APIEndpoint,
  status: number,
  competition?: string,
  season?: string,
) {
  try {
    await track('API request failed', {
      endpoint,
      status,
      competition,
      season,
    });
  } catch {
    // Analytics must never affect an API response.
  }
}
