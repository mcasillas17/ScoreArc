import { track } from '@vercel/analytics/server';

type APIEndpoint =
  | 'bracket'
  | 'match-summary'
  | 'matches'
  | 'news'
  | 'standings'
  | 'top-scorers'
  | 'upcoming';

const eventIntervalMs = 60_000;
const eventTimeoutMs = 250;
const lastTrackedAt = new Map<string, number>();

export async function trackAPIRequestFailure(
  request: Request,
  endpoint: APIEndpoint,
  status: number,
  competition?: string,
  season?: string,
) {
  const key = `${endpoint}:${status}`;
  const now = Date.now();
  if ((lastTrackedAt.get(key) ?? 0) + eventIntervalMs > now) return;
  lastTrackedAt.set(key, now);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      track('API request failed', {
        endpoint,
        status,
        competition,
        season,
      }, { request }),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, eventTimeoutMs);
      }),
    ]);
  } catch {
    // Analytics must never affect an API response.
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
