// A Vercel drain can attach the same proxy observation to several runtime log messages.
function endpointFor(path: string) {
  const parts = path.split('?', 1)[0].replace(/\/$/, '').split('/');
  if (parts[1] !== 'api') return;
  if (parts.length === 3 && parts[2] === 'og') return 'og';
  if (parts.length === 5 && ['matches', 'bracket', 'news', 'standings', 'top-scorers', 'top-assists'].includes(parts[4])) return parts[4];
  if (parts.length === 6 && parts[4] === 'standings' && parts[5] === 'form') return 'standings-form';
  if (parts.length === 6 && ['match', 'team', 'player'].includes(parts[4])) return parts[4] === 'match' ? 'match-summary' : parts[4];
  return 'unmatched';
}
const cacheStates = new Set(['HIT', 'STALE', 'MISS', 'BYPASS', 'PRERENDER', 'REVALIDATED']);

export function vercelApiAccess() {
  type Hit = { bucketStart: string; endpoint: string; method: string; status: number; cache: string; environment: string };
  const seen = new Map<string, Hit | null>();
  let unkeyedRecords = 0, conflictingRequests = 0;
  return {
    add(record: Record<string, unknown>) {
      const proxy = record.proxy;
      if (!proxy || typeof proxy !== 'object' || !('path' in proxy) || typeof proxy.path !== 'string') return;
      const endpoint = endpointFor(proxy.path);
      if (!endpoint || !('statusCode' in proxy) || typeof proxy.statusCode !== 'number' || !Number.isInteger(proxy.statusCode) ||
          proxy.statusCode < 100 || proxy.statusCode > 599 || !('timestamp' in proxy) || typeof proxy.timestamp !== 'number' ||
          !Number.isFinite(new Date(proxy.timestamp).getTime())) return;
      const id = 'vercelId' in proxy && proxy.vercelId || record.requestId;
      if (typeof id !== 'string' || !id || typeof record.projectId !== 'string') { unkeyedRecords++; return; }
      const key = JSON.stringify([record.projectId, id]);
      const hit: Hit = { bucketStart: new Date(Math.floor(proxy.timestamp / 300_000) * 300_000).toISOString(), endpoint,
        method: 'method' in proxy && typeof proxy.method === 'string' && /^(?:GET|HEAD|PUT|POST|PATCH|DELETE|OPTIONS|CONNECT|TRACE)$/.test(proxy.method) ? proxy.method : 'OTHER',
        status: proxy.statusCode, cache: 'vercelCache' in proxy && typeof proxy.vercelCache === 'string' && cacheStates.has(proxy.vercelCache) ? proxy.vercelCache : 'unknown',
        environment: ['production', 'preview', 'development'].includes(String(record.environment)) ? String(record.environment) : 'unknown' };
      const previous = seen.get(key);
      if (previous === undefined) seen.set(key, hit);
      else if (previous && JSON.stringify(previous) !== JSON.stringify(hit)) { seen.set(key, null); conflictingRequests++; }
    },
    result() {
      const rows = new Map<string, Hit & { requests: number }>();
      for (const hit of seen.values()) {
        if (!hit) continue;
        const key = JSON.stringify(hit), existing = rows.get(key);
        if (existing) existing.requests++;
        else rows.set(key, { ...hit, requests: 1 });
      }
      return { observedRequests: seen.size - conflictingRequests, conflictingRequests, unkeyedRecords, intervals: [...rows.values()] };
    },
  };
}
