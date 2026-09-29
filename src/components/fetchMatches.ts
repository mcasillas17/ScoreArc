import type { Match } from '@/server/data/types';

/** One competition's matches for a YYYYMMDD-YYYYMMDD range. Throws on a non-2xx
 *  (carrying `status`) or a body that is not a list, so every caller keeps its
 *  last good list and reports the feed failure the same way. */
export async function fetchMatches(apiBase: string, range: string, signal?: AbortSignal): Promise<Match[]> {
  const res = await fetch(`${apiBase}/matches?range=${encodeURIComponent(range)}`, { cache: 'no-store', signal });
  if (!res.ok) throw Object.assign(new Error(`matches request failed with status ${res.status}`), { status: res.status });
  const data: unknown = await res.json();
  if (!Array.isArray(data)) throw new Error('matches response was not an array');
  return data as Match[];
}
